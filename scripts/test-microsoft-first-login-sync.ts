/**
 * Regression test for the first-login sync bug: DepartmentMembership and
 * global role must apply on the SAME login that creates the user, not a
 * second one. Unlike test-microsoft-graph-sync.ts / test-microsoft-role-sync.ts
 * (pure functions, no DB), this needs a real database, because the bug was
 * specifically about DB row timing — so this script:
 *   - mocks the Graph /me fetch (same pattern as the other scripts)
 *   - makes real Prisma calls against DATABASE_URL
 *   - creates its own throwaway Department/MicrosoftDepartmentMapping/User
 *     rows and deletes everything it created at the end, pass or fail
 *
 * Usage: npx tsx scripts/test-microsoft-first-login-sync.ts
 * Requires a reachable DATABASE_URL — prints a clear message and exits if
 * one isn't configured/reachable, rather than failing confusingly.
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole, GlobalRoleSource, MembershipSource, MicrosoftMappingSourceType, Role, AuthProvider } from "@prisma/client";
import { syncMicrosoftUserDepartment, handleMicrosoftJwtSignIn } from "@/lib/services/microsoft-department-sync-service";
import { syncMicrosoftDirectoryValues, normalizeJobTitleValue } from "@/lib/services/microsoft-directory-service";
import { createMapping, updateMapping, MicrosoftMappingValidationError } from "@/lib/services/microsoft-mapping-service";
import { normalizeDepartmentName } from "@/lib/services/organization-normalization";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

const RUN_ID = Date.now();
const TEST_DEPT_SLUG = `test-first-login-dept-${RUN_ID}`;
const TEST_MAPPING_VALUE = `Test Systems Operations ${RUN_ID}`;
const TEST_LOW_PRIORITY_DEPT_VALUE = `Test Systems Operations Low ${RUN_ID}`;
const TEST_JOB_TITLE_MANAGER_VALUE = `Test Systems Operations Manager ${RUN_ID}`;
const TEST_JOB_TITLE_ASSISTANT_VALUE = `Test IT Operations Assistant ${RUN_ID}`;
const testUserIds: string[] = [];
/** Raw Graph department-string values that resolveOrganizationPlacement will have created a real (companyId: null) Department for — tracked here so `finally` can clean them up too. */
const resolvedDeptNames = new Set<string>();

function mockGraphMeOnce(department: string | null, oid = `test-oid-${RUN_ID}`, jobTitle: string | null = null) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({
        id: oid,
        displayName: "Test User",
        mail: null,
        userPrincipalName: null,
        department,
        jobTitle,
      }),
      { status: 200 }
    )) as typeof fetch;
}

/**
 * FIND-003 (docs/roadmap-handoff-register.md): PRIMARY department placement
 * now comes from organization-company-department-resolver.ts's
 * name-based, company-scoped resolution (using the raw Graph `department`
 * string directly), never from a MicrosoftDepartmentMapping row — a Graph
 * `department` value can still ALSO have a MicrosoftDepartmentMapping
 * pointing at a completely different, arbitrarily-named Department for
 * SECONDARY-membership/global-role purposes (that mechanism is unchanged).
 * This looks up the department the resolver would have created/found for a
 * given raw Graph department string, mirroring exactly what
 * resolveOrganizationPlacement does (no companyName in this file's mocks ->
 * companyId: null).
 */
async function findResolvedPrimaryDepartment(rawDepartmentName: string) {
  return prisma.department.findFirst({
    where: { companyId: null, normalizedName: normalizeDepartmentName(rawDepartmentName) },
  });
}

async function createTestUser(data: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `test-first-login-${RUN_ID}-${testUserIds.length}@kinsen.gr`,
      authProvider: AuthProvider.MICROSOFT,
      ...data,
    },
  });
  testUserIds.push(user.id);
  return user;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping (run this in an environment with a real DB).");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  // Declared here (not assigned until inside the try below) so a failure
  // partway through fixture creation still gets cleaned up by the finally
  // block below, instead of leaking rows into the database.
  let department: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const mappingIds: string[] = [];

  try {
    department = await prisma.department.create({
      data: { name: `Test IT Dept ${RUN_ID}`, slug: TEST_DEPT_SLUG },
    });
    // MicrosoftDepartmentMapping now stores `role` (GLOBAL Role, matches
    // /admin/roles) and `departmentRole` (DepartmentRole) independently —
    // set here to the SAME values translateGlobalRoleToDepartmentRole would
    // have produced, so Scenarios 1-8 below keep asserting the same expected
    // end values as before this change. Scenario 9 below is the one that
    // actually proves departmentRole is applied verbatim, not re-derived.
    // FIND-006 (docs/roadmap-handoff-register.md): MicrosoftDepartmentMapping's
    // canonical identity is now (sourceType, domain, normalizedMicrosoftValue)
    // — every raw `.create()` below (bypassing the createMapping() service,
    // which computes these two fields automatically) must set them
    // explicitly, or every PROFILE_DEPARTMENT row here would collide on the
    // shared domain="" / normalizedMicrosoftValue="" default. PROFILE_DEPARTMENT
    // stays global (domain: "", normalizedMicrosoftValue: an exact copy of
    // microsoftValue); PROFILE_JOB_TITLE is domain-scoped (domain: "kinsen.gr"
    // — this file's users are all @kinsen.gr — normalizedMicrosoftValue via
    // the SAME normalizeJobTitleValue the discovery catalog and
    // microsoft-mapping-service.ts's createMapping both use).
    const mapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
        microsoftValue: TEST_MAPPING_VALUE,
        domain: "",
        normalizedMicrosoftValue: TEST_MAPPING_VALUE,
        departmentId: department.id,
        role: Role.DEPARTMENT_MANAGER,
        departmentRole: DepartmentRole.DEPARTMENT_MANAGER,
      },
    });
    mappingIds.push(mapping.id);

    // A second, distinct department-value mapping (global role: USER,
    // department role: REQUESTER) + two job-title mappings pointing at the
    // SAME department, for the job-title-overrides-department priority
    // scenarios (§9 Cases 1-3) — kept separate from `mapping` above so those
    // scenarios don't disturb the already-asserted behavior in Scenarios 1-8.
    const lowPriorityDeptMapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
        microsoftValue: TEST_LOW_PRIORITY_DEPT_VALUE,
        domain: "",
        normalizedMicrosoftValue: TEST_LOW_PRIORITY_DEPT_VALUE,
        departmentId: department.id,
        role: Role.USER,
        departmentRole: DepartmentRole.REQUESTER,
      },
    });
    mappingIds.push(lowPriorityDeptMapping.id);
    const jobTitleManagerMapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: TEST_JOB_TITLE_MANAGER_VALUE,
        domain: "kinsen.gr",
        normalizedMicrosoftValue: normalizeJobTitleValue(TEST_JOB_TITLE_MANAGER_VALUE),
        departmentId: department.id,
        role: Role.DEPARTMENT_MANAGER,
        departmentRole: DepartmentRole.DEPARTMENT_MANAGER,
      },
    });
    mappingIds.push(jobTitleManagerMapping.id);
    const jobTitleAssistantMapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: TEST_JOB_TITLE_ASSISTANT_VALUE,
        domain: "kinsen.gr",
        normalizedMicrosoftValue: normalizeJobTitleValue(TEST_JOB_TITLE_ASSISTANT_VALUE),
        departmentId: department.id,
        role: Role.IT_AGENT,
        departmentRole: DepartmentRole.AGENT_ASSIGNEE,
      },
    });
    mappingIds.push(jobTitleAssistantMapping.id);

    console.log("Scenario 1: brand-new user, first login, mapping exists\n");
    const user1 = await createTestUser();
    mockGraphMeOnce(TEST_MAPPING_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: user1.id,
      oid: `test-oid-${RUN_ID}-1`,
      email: user1.email,
      name: "Test User",
    });
    const afterFirstLogin = await prisma.user.findUnique({ where: { id: user1.id } });
    // PRIMARY placement (FIND-003): resolved by name from the raw Graph
    // `department` string (TEST_MAPPING_VALUE), NOT department.id — that
    // fixture is now purely a SECONDARY-membership/global-role target via
    // its MicrosoftDepartmentMapping row (see the checks below).
    const resolvedPrimaryDept = await findResolvedPrimaryDepartment(TEST_MAPPING_VALUE);
    resolvedDeptNames.add(TEST_MAPPING_VALUE);
    const primaryMembership1 = resolvedPrimaryDept
      ? await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: resolvedPrimaryDept.id } } })
      : null;
    // SECONDARY membership, via the pre-configured MicrosoftDepartmentMapping — unchanged mechanism.
    const secondaryMembership1 = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: user1.id, departmentId: department.id } },
    });
    check("User.role === DEPARTMENT_MANAGER on first login", afterFirstLogin?.role === Role.DEPARTMENT_MANAGER);
    check("User.globalRoleSource === MICROSOFT_DEPARTMENT", afterFirstLogin?.globalRoleSource === GlobalRoleSource.MICROSOFT_DEPARTMENT);
    check("User.globalRoleMicrosoftMappingId === mapping.id", afterFirstLogin?.globalRoleMicrosoftMappingId === mapping.id);
    check("User.departmentId === resolved PRIMARY department (name-resolved, not the MicrosoftDepartmentMapping target)", resolvedPrimaryDept !== null && afterFirstLogin?.departmentId === resolvedPrimaryDept.id);
    check("User.lastMicrosoftSyncAt is set", afterFirstLogin?.lastMicrosoftSyncAt != null);
    check("PRIMARY DepartmentMembership exists on first login", primaryMembership1 !== null && primaryMembership1.isPrimary === true && primaryMembership1.isActive === true);
    check("SECONDARY DepartmentMembership (via MicrosoftDepartmentMapping) ALSO exists, not primary", secondaryMembership1 !== null && secondaryMembership1.isPrimary === false);
    check("SECONDARY DepartmentMembership.role === DEPARTMENT_MANAGER", secondaryMembership1?.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("SECONDARY DepartmentMembership.source === MICROSOFT_DEPARTMENT", secondaryMembership1?.source === MembershipSource.MICROSOFT_DEPARTMENT);
    check("SECONDARY DepartmentMembership.isActive === true", secondaryMembership1?.isActive === true);

    console.log("\nScenario 2: same user logs in again — idempotent, no duplicates\n");
    mockGraphMeOnce(TEST_MAPPING_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: user1.id,
      oid: `test-oid-${RUN_ID}-1`,
      email: user1.email,
      name: "Test User",
    });
    const membershipCount = await prisma.departmentMembership.count({ where: { userId: user1.id } });
    // Two rows are correct and expected: one PRIMARY (organizational
    // placement, resolver-created department) + one SECONDARY (via the
    // pre-configured MicrosoftDepartmentMapping) — the assertion is about
    // idempotency (no NEW/duplicate rows on a second identical login), not
    // about there being exactly one row overall.
    check("still exactly two DepartmentMembership rows after second login (1 primary + 1 secondary, no duplicates created)", membershipCount === 2);

    console.log("\nScenario 3: existing local/credentials user, first Microsoft login\n");
    const localUser = await createTestUser({ authProvider: AuthProvider.CREDENTIALS, passwordHash: "irrelevant" });
    mockGraphMeOnce(TEST_MAPPING_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: localUser.id,
      oid: `test-oid-${RUN_ID}-3`,
      email: localUser.email,
      name: "Test User",
    });
    const afterLink = await prisma.user.findUnique({ where: { id: localUser.id } });
    check("hybrid local user gets mapped role on first Microsoft login", afterLink?.role === Role.DEPARTMENT_MANAGER);

    console.log("\nScenario 4: manual global role override is protected\n");
    const manualUser = await createTestUser({ globalRoleSource: GlobalRoleSource.MANUAL, role: Role.USER });
    mockGraphMeOnce(TEST_MAPPING_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: manualUser.id,
      oid: `test-oid-${RUN_ID}-4`,
      email: manualUser.email,
      name: "Test User",
    });
    const afterManual = await prisma.user.findUnique({ where: { id: manualUser.id } });
    check("MANUAL globalRoleSource role untouched", afterManual?.role === Role.USER);
    check("globalRoleSource stays MANUAL", afterManual?.globalRoleSource === GlobalRoleSource.MANUAL);

    console.log("\nScenario 5: System Admin is never downgraded\n");
    const adminUser = await createTestUser({ role: Role.ADMIN });
    mockGraphMeOnce(TEST_MAPPING_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: adminUser.id,
      oid: `test-oid-${RUN_ID}-5`,
      email: adminUser.email,
      name: "Test User",
    });
    const afterAdmin = await prisma.user.findUnique({ where: { id: adminUser.id } });
    check("Role.ADMIN untouched after Microsoft sync", afterAdmin?.role === Role.ADMIN);

    console.log("\nScenario 6: MANUAL DepartmentMembership is protected\n");
    const manualMemberUser = await createTestUser();
    await prisma.departmentMembership.create({
      data: {
        userId: manualMemberUser.id,
        departmentId: department.id,
        role: DepartmentRole.VIEWER,
        source: MembershipSource.MANUAL,
      },
    });
    mockGraphMeOnce(TEST_MAPPING_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: manualMemberUser.id,
      oid: `test-oid-${RUN_ID}-6`,
      email: manualMemberUser.email,
      name: "Test User",
    });
    const manualMembership = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: manualMemberUser.id, departmentId: department.id } },
    });
    check("MANUAL membership role untouched (still VIEWER, not DEPARTMENT_MANAGER)", manualMembership?.role === DepartmentRole.VIEWER);
    check("MANUAL membership source untouched", manualMembership?.source === MembershipSource.MANUAL);

    console.log("\nScenario 7: no matching MicrosoftDepartmentMapping — no role/secondary-membership promotion, but PRIMARY placement still resolves (FIND-003, independent mechanism)\n");
    const unmappedDeptValue = `Unmapped Department ${RUN_ID}`;
    const unmappedUser = await createTestUser();
    mockGraphMeOnce(unmappedDeptValue);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: unmappedUser.id,
      oid: `test-oid-${RUN_ID}-7`,
      email: unmappedUser.email,
      name: "Test User",
    });
    const afterUnmapped = await prisma.user.findUnique({ where: { id: unmappedUser.id } });
    const unmappedMembershipCount = await prisma.departmentMembership.count({ where: { userId: unmappedUser.id } });
    const unmappedResolvedDept = await findResolvedPrimaryDepartment(unmappedDeptValue);
    resolvedDeptNames.add(unmappedDeptValue);
    check("no role promotion when no MicrosoftDepartmentMapping matches", afterUnmapped?.role === Role.USER);
    check("globalRoleSource stays SYSTEM (untouched) when no mapping matches", afterUnmapped?.globalRoleSource === GlobalRoleSource.SYSTEM);
    // PRIMARY placement is a SEPARATE mechanism from MicrosoftDepartmentMapping
    // (FIND-003) — it resolves/creates a department purely from the raw Graph
    // `department` string, with or without any admin-configured mapping.
    check("exactly ONE DepartmentMembership exists (the PRIMARY one, resolver-created — no mapping needed for this)", unmappedMembershipCount === 1);
    check("that membership is primary and points at the resolver-created department", unmappedResolvedDept !== null && afterUnmapped?.departmentId === unmappedResolvedDept.id);
    check("lastMicrosoftSyncAt still set (Graph call itself succeeded)", afterUnmapped?.lastMicrosoftSyncAt != null);

    console.log("\nScenario 8: handleMicrosoftJwtSignIn returns FRESH token fields, not the stale pre-sync snapshot\n");
    // Reproduces the exact live bug: lib/auth.ts used to assign token
    // fields from the row it fetched BEFORE calling sync, so a brand-new
    // user's first-login token/session kept role: USER even though the DB
    // was correctly updated underneath. This calls the exact function
    // lib/auth.ts now calls, starting from a "pre-sync" snapshot with
    // role: USER, and asserts the RETURNED object — which lib/auth.ts
    // assigns directly onto `token` — already has the mapped role.
    const jwtUser = await createTestUser();
    const preSyncSnapshot = await prisma.user.findUnique({
      where: { id: jwtUser.id },
      select: {
        id: true, role: true, isActive: true, mustChangePassword: true,
        departmentId: true, businessUnitId: true, customRoleId: true,
        microsoftUserId: true, globalRoleSource: true, name: true, image: true,
      },
    });
    if (!preSyncSnapshot) throw new Error("test setup failed: jwtUser not found");
    check("pre-sync snapshot has the stale default role (sanity check)", preSyncSnapshot.role === Role.USER);

    mockGraphMeOnce(TEST_MAPPING_VALUE, `test-oid-${RUN_ID}-8`);
    const postSync = await handleMicrosoftJwtSignIn({
      dbUser: preSyncSnapshot,
      accessToken: "fake-token",
      oid: `test-oid-${RUN_ID}-8`,
      providerAccountId: `test-oid-${RUN_ID}-8`,
      userEmail: jwtUser.email,
      userName: "Test User",
    });
    const scenario8ResolvedDept = await findResolvedPrimaryDepartment(TEST_MAPPING_VALUE);
    check("returned object has the MAPPED role, not the stale pre-sync USER", postSync.role === Role.DEPARTMENT_MANAGER);
    check("returned object has the resolved PRIMARY departmentId (name-resolved, FIND-003)", scenario8ResolvedDept !== null && postSync.departmentId === scenario8ResolvedDept.id);
    check("returned object has globalRoleSource MICROSOFT_DEPARTMENT", postSync.globalRoleSource === GlobalRoleSource.MICROSOFT_DEPARTMENT);
    check("pre-sync snapshot object itself is untouched (still role USER)", preSyncSnapshot.role === Role.USER);

    console.log("\nCase 1: job title mapping overrides department-only mapping for the same department (Department Manager)\n");
    const case1User = await createTestUser();
    mockGraphMeOnce(TEST_LOW_PRIORITY_DEPT_VALUE, `test-oid-${RUN_ID}-9`, TEST_JOB_TITLE_MANAGER_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: case1User.id,
      oid: `test-oid-${RUN_ID}-9`,
      email: case1User.email,
      name: "Test User",
    });
    const case1Membership = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: case1User.id, departmentId: department.id } },
    });
    check("Case 1: role is DEPARTMENT_MANAGER (job title wins over department)", case1Membership?.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("Case 1: source is MICROSOFT_JOB_TITLE", case1Membership?.source === MembershipSource.MICROSOFT_JOB_TITLE);

    console.log("\nCase 2: a different job title on the same department yields a different role (Agent/Assignee)\n");
    const case2User = await createTestUser();
    mockGraphMeOnce(TEST_LOW_PRIORITY_DEPT_VALUE, `test-oid-${RUN_ID}-10`, TEST_JOB_TITLE_ASSISTANT_VALUE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: case2User.id,
      oid: `test-oid-${RUN_ID}-10`,
      email: case2User.email,
      name: "Test User",
    });
    const case2Membership = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: case2User.id, departmentId: department.id } },
    });
    check("Case 2: role is AGENT_ASSIGNEE", case2Membership?.role === DepartmentRole.AGENT_ASSIGNEE);
    check("Case 2: source is MICROSOFT_JOB_TITLE", case2Membership?.source === MembershipSource.MICROSOFT_JOB_TITLE);

    console.log("\nCase 3: jobTitle is null — falls back to the department-only mapping (Requester)\n");
    const case3User = await createTestUser();
    mockGraphMeOnce(TEST_LOW_PRIORITY_DEPT_VALUE, `test-oid-${RUN_ID}-11`, null);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: case3User.id,
      oid: `test-oid-${RUN_ID}-11`,
      email: case3User.email,
      name: "Test User",
    });
    const case3Membership = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: case3User.id, departmentId: department.id } },
    });
    check("Case 3: role is REQUESTER (department-only mapping applies)", case3Membership?.role === DepartmentRole.REQUESTER);
    check("Case 3: source is MICROSOFT_DEPARTMENT", case3Membership?.source === MembershipSource.MICROSOFT_DEPARTMENT);

    console.log("\nCase 4: login /me caches a jobTitle value even with no matching mapping\n");
    const case4JobTitleValue = `Test Unmapped Job Title ${RUN_ID}`;
    const case4User = await createTestUser();
    mockGraphMeOnce(null, `test-oid-${RUN_ID}-12`, case4JobTitleValue);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: case4User.id,
      oid: `test-oid-${RUN_ID}-12`,
      email: case4User.email,
      name: "Test User",
    });
    // `value` is display-only, not a unique key (see the model's schema
    // comment — canonical identity is (domain, normalizedValue)) — findFirst,
    // not findUnique.
    const cachedJobTitle = await prisma.microsoftDirectoryJobTitleValue.findFirst({ where: { value: case4JobTitleValue } });
    check("Case 4: MicrosoftDirectoryJobTitleValue upserted with the exact jobTitle value", cachedJobTitle !== null);
    check("Case 4: cached value is active", cachedJobTitle?.isActive === true);

    console.log("\nCase 5: full tenant sync dedupes and skips empty department/jobTitle values\n");
    // fetchAllGraphUserDirectoryValues (called via syncMicrosoftDirectoryValues)
    // makes TWO Graph calls, not one: first getAppOnlyGraphAccessToken() hits
    // Microsoft's OAuth token endpoint (login.microsoftonline.com), THEN the
    // actual GET /users call hits graph.microsoft.com. Both go through the
    // same global fetch — a mock that answers unconditionally would hand the
    // token endpoint the /users fixture instead of a token, and (before
    // reaching that) getAppOnlyGraphAccessToken's own credential validation
    // (lib/microsoft-graph.ts) requires syntactically valid
    // GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET before it ever calls fetch at
    // all — this environment genuinely has none configured. Neither of those
    // is a reason to skip Case 5 or relax production validation: this test
    // supplies its own deterministic, syntactically-valid FAKE credentials
    // (process.env, this process only — the real .env file is never read or
    // written) and a URL-routing fetch mock that answers each endpoint with
    // its own fixture, so the full real code path (credential validation +
    // token exchange + paginated Graph read) runs against zero real network
    // I/O and zero real secrets.
    const FAKE_GRAPH_TENANT_ID = "00000000-0000-4000-8000-000000000001";
    const FAKE_GRAPH_CLIENT_ID = "00000000-0000-4000-8000-000000000002";
    const FAKE_GRAPH_CLIENT_SECRET = `hermetic-test-fixture-secret-${RUN_ID}`;
    const savedGraphEnv = {
      GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID,
      GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID,
      GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET,
    };
    process.env.GRAPH_TENANT_ID = FAKE_GRAPH_TENANT_ID;
    process.env.GRAPH_CLIENT_ID = FAKE_GRAPH_CLIENT_ID;
    process.env.GRAPH_CLIENT_SECRET = FAKE_GRAPH_CLIENT_SECRET;

    const case5DeptA = `Test Sync Dept A ${RUN_ID}`;
    const case5TitleA = `Test Sync Title A ${RUN_ID}`;
    let case5TokenCalls = 0;
    let case5UsersCalls = 0;
    (global as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.startsWith("https://login.microsoftonline.com/")) {
        case5TokenCalls++;
        return new Response(
          JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: `fake-app-only-token-${RUN_ID}` }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.startsWith("https://graph.microsoft.com/v1.0/users")) {
        case5UsersCalls++;
        // Operation B's tenant scan now only collects department/jobTitle
        // values from eligible (`userType: "Member"`,
        // `@<ALLOWED_EMAIL_DOMAIN>`) users — see
        // organization-directory-eligibility-service.ts / FIND-003. Every
        // fixture row here must be eligibility-shaped, or it's silently
        // excluded before ever reaching the dedup/trim logic under test.
        return new Response(
          JSON.stringify({
            value: [
              { userType: "Member", mail: `case5-a-${RUN_ID}@kinsen.gr`, department: case5DeptA, jobTitle: case5TitleA },
              { userType: "Member", mail: `case5-b-${RUN_ID}@kinsen.gr`, department: case5DeptA, jobTitle: case5TitleA.toUpperCase() }, // duplicate dept, differently-cased title (department stays case-sensitive -> distinct value; matching behavior is separate from caching, which stores exact values)
              { userType: "Member", mail: `case5-c-${RUN_ID}@kinsen.gr`, department: "  " + case5DeptA + "  ", jobTitle: null }, // same dept after trim, null title
              { userType: "Member", mail: `case5-d-${RUN_ID}@kinsen.gr`, department: "", jobTitle: "" }, // empty values, must be skipped
              { userType: "Member", mail: `case5-e-${RUN_ID}@kinsen.gr`, department: null, jobTitle: undefined },
              // Deliberately ineligible rows — must be excluded, not counted:
              { userType: "Guest", mail: `case5-guest-${RUN_ID}@kinsen.gr`, department: case5DeptA, jobTitle: case5TitleA }, // Guest, otherwise-matching domain
              { userType: "Member", mail: `case5-f-${RUN_ID}@othercorp.com`, department: case5DeptA, jobTitle: case5TitleA }, // Member, wrong domain
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Case 5's fetch mock received an unexpected URL: ${url}`);
    }) as typeof fetch;

    const syncResult = await syncMicrosoftDirectoryValues();
    check("Case 5: sync succeeded", syncResult.ok === true);
    check("Case 5: no real network request was made (both calls hit the in-process mock)", case5TokenCalls === 1 && case5UsersCalls === 1);
    if (syncResult.ok) {
      check("Case 5: discovered exactly 1 distinct department (after trim)", syncResult.discoveredDepartments === 1);
      // Job titles now dedup case/whitespace-insensitively (normalizeJobTitleValue,
      // microsoft-directory-service.ts) — matches the SAME case-insensitive
      // rule microsoft-mapping-service.ts's findActiveMappingsForClaims
      // already uses to MATCH a job title mapping at sync/login time, so the
      // discovered count reflects what will actually match one mapping, not
      // a raw-string artifact. case5TitleA and its .toUpperCase() variant are
      // deliberately the same title, seen from two different eligible users —
      // exactly 1 distinct title, not 2 (department values are intentionally
      // NOT normalized this way — see MicrosoftDirectoryDepartmentValue,
      // unchanged).
      check("Case 5: discovered exactly 1 distinct job title (case/whitespace-insensitive dedup)", syncResult.discoveredJobTitles === 1);
    }
    const cachedDeptA = await prisma.microsoftDirectoryDepartmentValue.findUnique({ where: { value: case5DeptA } });
    // `value` is display-only on this table now, not a unique key (see the
    // model's schema comment) — findFirst, not findUnique.
    const cachedTitleA = await prisma.microsoftDirectoryJobTitleValue.findFirst({ where: { value: case5TitleA } });
    check("Case 5: trimmed department value cached", cachedDeptA !== null && cachedDeptA.isActive);
    check("Case 5: job title value cached", cachedTitleA !== null && cachedTitleA.isActive);

    console.log("\nCase 6: missing Graph credentials return a controlled configuration error, never a crash or a real request\n");
    delete process.env.GRAPH_TENANT_ID;
    delete process.env.GRAPH_CLIENT_ID;
    delete process.env.GRAPH_CLIENT_SECRET;
    let case6FetchCalls = 0;
    (global as unknown as { fetch: typeof fetch }).fetch = (async () => {
      case6FetchCalls++;
      throw new Error("Case 6's fetch mock should never be called — credential validation must reject before any request is attempted.");
    }) as typeof fetch;
    let case6Threw = false;
    let case6Result: Awaited<ReturnType<typeof syncMicrosoftDirectoryValues>> | undefined;
    try {
      case6Result = await syncMicrosoftDirectoryValues();
    } catch {
      case6Threw = true;
    }
    check("Case 6: missing credentials never throws an uncaught exception", !case6Threw);
    check('Case 6: returns a controlled, distinctly-labeled result (ok:false, reason:"configuration_error")', case6Result?.ok === false && (case6Result as { reason?: string })?.reason === "configuration_error");
    check("Case 6: no fetch call was attempted at all (fails before any network I/O)", case6FetchCalls === 0);

    // Restore this process's env exactly as it was before Case 5/6 — never
    // touches the real .env file on disk, only this process's in-memory
    // environment. Assigning `undefined` to process.env.X would coerce it
    // to the literal string "undefined" (Node only stores strings there),
    // so an originally-unset var must be `delete`d, not reassigned.
    for (const [key, value] of Object.entries(savedGraphEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }

    console.log("\nScenario 9: explicit departmentRole is applied verbatim, never re-derived from globalRole\n");
    const TEST_VERBATIM_VALUE = `Test Verbatim Dept ${RUN_ID}`;
    // Global Role USER would translate to REQUESTER by default — deliberately
    // pick a DIFFERENT departmentRole (AGENT_ASSIGNEE) to prove
    // resolveDepartmentMemberships reads the stored departmentRole directly
    // instead of re-deriving it via translateGlobalRoleToDepartmentRole.
    const verbatimMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: TEST_VERBATIM_VALUE,
      departmentId: department.id,
      role: Role.USER,
      departmentRole: DepartmentRole.AGENT_ASSIGNEE,
    });
    mappingIds.push(verbatimMapping.id);
    const verbatimUser = await createTestUser();
    mockGraphMeOnce(TEST_VERBATIM_VALUE, `test-oid-${RUN_ID}-verbatim`);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: verbatimUser.id,
      oid: `test-oid-${RUN_ID}-verbatim`,
      email: verbatimUser.email,
      name: "Test User",
    });
    const verbatimUserAfter = await prisma.user.findUnique({ where: { id: verbatimUser.id } });
    const verbatimMembership = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: verbatimUser.id, departmentId: department.id } },
    });
    check("Scenario 9: User.role === USER (globalRole applied)", verbatimUserAfter?.role === Role.USER);
    check(
      "Scenario 9: DepartmentMembership.role === AGENT_ASSIGNEE (explicit departmentRole, NOT the REQUESTER translateGlobalRoleToDepartmentRole would derive)",
      verbatimMembership?.role === DepartmentRole.AGENT_ASSIGNEE
    );

    console.log("\nScenario 10: Administrator cannot be granted as Global Role via createMapping\n");
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `Test Admin Blocked ${RUN_ID}`,
        departmentId: department.id,
        role: Role.ADMIN,
        departmentRole: DepartmentRole.REQUESTER,
      });
      check("Scenario 10: createMapping rejects Role.ADMIN", false);
    } catch (err) {
      check(
        "Scenario 10: createMapping rejects Role.ADMIN with ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING",
        err instanceof MicrosoftMappingValidationError && err.code === "ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING"
      );
    }

    console.log("\nScenario 11: Department Admin cannot be granted as Department Role via createMapping\n");
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `Test Dept Admin Blocked ${RUN_ID}`,
        departmentId: department.id,
        role: Role.USER,
        departmentRole: DepartmentRole.DEPARTMENT_ADMIN,
      });
      check("Scenario 11: createMapping rejects DepartmentRole.DEPARTMENT_ADMIN", false);
    } catch (err) {
      check(
        "Scenario 11: createMapping rejects DepartmentRole.DEPARTMENT_ADMIN with DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING",
        err instanceof MicrosoftMappingValidationError && err.code === "DEPARTMENT_ROLE_NOT_ALLOWED_FOR_MICROSOFT_MAPPING"
      );
    }

    console.log("\nScenario 12: editing Global Role via updateMapping preserves the existing Department Role\n");
    const editMapping = await createMapping({
      sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
      microsoftValue: `Test Edit Preserves ${RUN_ID}`,
      departmentId: department.id,
      role: Role.USER,
      departmentRole: DepartmentRole.VIEWER,
    });
    mappingIds.push(editMapping.id);
    const editedMapping = await updateMapping(editMapping.id, { role: Role.IT_AGENT });
    check("Scenario 12: role updated to IT_AGENT", editedMapping.role === Role.IT_AGENT);
    check("Scenario 12: departmentRole untouched (still VIEWER)", editedMapping.departmentRole === DepartmentRole.VIEWER);

    console.log("\nScenario 13: createMapping rejects a non-existent department\n");
    try {
      await createMapping({
        sourceType: MicrosoftMappingSourceType.ENTRA_GROUP,
        microsoftValue: `Test Bad Department ${RUN_ID}`,
        departmentId: "nonexistent-department-id",
        role: Role.USER,
        departmentRole: DepartmentRole.REQUESTER,
      });
      check("Scenario 13: createMapping rejects a missing department", false);
    } catch (err) {
      check(
        "Scenario 13: createMapping rejects a missing department with DEPARTMENT_NOT_FOUND",
        err instanceof MicrosoftMappingValidationError && err.code === "DEPARTMENT_NOT_FOUND"
      );
    }
  } finally {
    // Each step is independently guarded: one cleanup step failing (e.g.
    // the JobTitleValue table not existing yet, pre-migration) must not
    // mask the original test failure or skip $disconnect for the rest.
    //
    // FIND-003: swept by RUN_ID-tagged name rather than the specific
    // constants tracked in resolvedDeptNames (TEST_MAPPING_VALUE,
    // unmappedDeptValue) — a broad, robust net that also catches
    // TEST_LOW_PRIORITY_DEPT_VALUE/TEST_VERBATIM_VALUE (Cases 1-4, Scenario
    // 9), which ALSO get resolver-created as PRIMARY-placement departments
    // now that every eligible login resolves one, independent of which
    // MicrosoftDepartmentMapping scenario each case is actually testing.
    void resolvedDeptNames; // superseded by the broad sweep below; kept only for the inline resolvedDeptNames.add() call-site comments' context
    const resolvedDepts = await prisma.department.findMany({ where: { companyId: null, name: { contains: RUN_ID.toString() } }, select: { id: true } });
    const resolvedDeptIds = resolvedDepts.map((d) => d.id);

    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: testUserIds } } })],
      ["user", () => prisma.user.deleteMany({ where: { id: { in: testUserIds } } })],
      ["microsoftDepartmentMapping", () =>
        mappingIds.length > 0
          ? prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } })
          : Promise.resolve()],
      // FIND-003: resolver-created PRIMARY-placement departments (companyId:
      // null, name-matched) also need their starter TicketPriority/TicketStatus
      // rows cleared first — same onDelete: RESTRICT FK as any other
      // createDepartment()-made department.
      ["resolved-department priorities", () => (resolvedDeptIds.length > 0 ? prisma.ticketPriority.deleteMany({ where: { departmentId: { in: resolvedDeptIds } } }) : Promise.resolve())],
      ["resolved-department statuses", () => (resolvedDeptIds.length > 0 ? prisma.ticketStatus.deleteMany({ where: { departmentId: { in: resolvedDeptIds } } }) : Promise.resolve())],
      ["resolved departments", () => (resolvedDeptIds.length > 0 ? prisma.department.deleteMany({ where: { id: { in: resolvedDeptIds } } }) : Promise.resolve())],
      // deleteMany (not delete): `department`'s own name also contains
      // RUN_ID, so the broad sweep above may have already removed it —
      // deleteMany is a safe no-op in that case, unlike delete's P2025 throw.
      ["department", () => (department ? prisma.department.deleteMany({ where: { id: department.id } }) : Promise.resolve())],
      ["microsoftDirectoryDepartmentValue", () =>
        prisma.microsoftDirectoryDepartmentValue.deleteMany({ where: { value: { contains: RUN_ID.toString() } } })],
      ["microsoftDirectoryJobTitleValue", () =>
        prisma.microsoftDirectoryJobTitleValue.deleteMany({ where: { value: { contains: RUN_ID.toString() } } })],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
