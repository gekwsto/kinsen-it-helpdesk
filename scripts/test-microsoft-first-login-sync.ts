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
import { syncMicrosoftDirectoryValues } from "@/lib/services/microsoft-directory-service";

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
    const mapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
        microsoftValue: TEST_MAPPING_VALUE,
        departmentId: department.id,
        role: DepartmentRole.DEPARTMENT_MANAGER,
      },
    });
    mappingIds.push(mapping.id);

    // A second, distinct department-value mapping (role: Requester) + two
    // job-title mappings pointing at the SAME department, for the
    // job-title-overrides-department priority scenarios (§9 Cases 1-3) —
    // kept separate from `mapping` above so those scenarios don't disturb
    // the already-asserted behavior in Scenarios 1-8.
    const lowPriorityDeptMapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
        microsoftValue: TEST_LOW_PRIORITY_DEPT_VALUE,
        departmentId: department.id,
        role: DepartmentRole.REQUESTER,
      },
    });
    mappingIds.push(lowPriorityDeptMapping.id);
    const jobTitleManagerMapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: TEST_JOB_TITLE_MANAGER_VALUE,
        departmentId: department.id,
        role: DepartmentRole.DEPARTMENT_MANAGER,
      },
    });
    mappingIds.push(jobTitleManagerMapping.id);
    const jobTitleAssistantMapping = await prisma.microsoftDepartmentMapping.create({
      data: {
        sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
        microsoftValue: TEST_JOB_TITLE_ASSISTANT_VALUE,
        departmentId: department.id,
        role: DepartmentRole.AGENT_ASSIGNEE,
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
    const membership1 = await prisma.departmentMembership.findUnique({
      where: { userId_departmentId: { userId: user1.id, departmentId: department.id } },
    });
    check("User.role === DEPARTMENT_MANAGER on first login", afterFirstLogin?.role === Role.DEPARTMENT_MANAGER);
    check("User.globalRoleSource === MICROSOFT_DEPARTMENT", afterFirstLogin?.globalRoleSource === GlobalRoleSource.MICROSOFT_DEPARTMENT);
    check("User.globalRoleMicrosoftMappingId === mapping.id", afterFirstLogin?.globalRoleMicrosoftMappingId === mapping.id);
    check("User.departmentId === department.id", afterFirstLogin?.departmentId === department.id);
    check("User.lastMicrosoftSyncAt is set", afterFirstLogin?.lastMicrosoftSyncAt != null);
    check("DepartmentMembership exists on first login", membership1 !== null);
    check("DepartmentMembership.role === DEPARTMENT_MANAGER", membership1?.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("DepartmentMembership.source === MICROSOFT_DEPARTMENT", membership1?.source === MembershipSource.MICROSOFT_DEPARTMENT);
    check("DepartmentMembership.isActive === true", membership1?.isActive === true);

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
    check("exactly one DepartmentMembership row after second login", membershipCount === 1);

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

    console.log("\nScenario 7: no matching mapping — no promotion, no membership\n");
    const unmappedUser = await createTestUser();
    mockGraphMeOnce(`Unmapped Department ${RUN_ID}`);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: unmappedUser.id,
      oid: `test-oid-${RUN_ID}-7`,
      email: unmappedUser.email,
      name: "Test User",
    });
    const afterUnmapped = await prisma.user.findUnique({ where: { id: unmappedUser.id } });
    const unmappedMembershipCount = await prisma.departmentMembership.count({ where: { userId: unmappedUser.id } });
    check("no role promotion when no mapping matches", afterUnmapped?.role === Role.USER);
    check("globalRoleSource stays SYSTEM (untouched) when no mapping matches", afterUnmapped?.globalRoleSource === GlobalRoleSource.SYSTEM);
    check("no DepartmentMembership created when no mapping matches", unmappedMembershipCount === 0);
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
    check("returned object has the MAPPED role, not the stale pre-sync USER", postSync.role === Role.DEPARTMENT_MANAGER);
    check("returned object has the mapped departmentId", postSync.departmentId === department.id);
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
    const cachedJobTitle = await prisma.microsoftDirectoryJobTitleValue.findUnique({ where: { value: case4JobTitleValue } });
    check("Case 4: MicrosoftDirectoryJobTitleValue upserted with the exact jobTitle value", cachedJobTitle !== null);
    check("Case 4: cached value is active", cachedJobTitle?.isActive === true);

    console.log("\nCase 5: full tenant sync dedupes and skips empty department/jobTitle values\n");
    const case5DeptA = `Test Sync Dept A ${RUN_ID}`;
    const case5TitleA = `Test Sync Title A ${RUN_ID}`;
    (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(
        JSON.stringify({
          value: [
            { department: case5DeptA, jobTitle: case5TitleA },
            { department: case5DeptA, jobTitle: case5TitleA.toUpperCase() }, // duplicate dept, differently-cased title (department stays case-sensitive -> distinct value; matching behavior is separate from caching, which stores exact values)
            { department: "  " + case5DeptA + "  ", jobTitle: null }, // same dept after trim, null title
            { department: "", jobTitle: "" }, // empty values, must be skipped
            { department: null, jobTitle: undefined },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;
    const syncResult = await syncMicrosoftDirectoryValues();
    check("Case 5: sync succeeded", syncResult.ok === true);
    if (syncResult.ok) {
      check("Case 5: discovered exactly 1 distinct department (after trim)", syncResult.discoveredDepartments === 1);
      check("Case 5: discovered exactly 2 distinct job titles (case-sensitive cache storage)", syncResult.discoveredJobTitles === 2);
    }
    const cachedDeptA = await prisma.microsoftDirectoryDepartmentValue.findUnique({ where: { value: case5DeptA } });
    const cachedTitleA = await prisma.microsoftDirectoryJobTitleValue.findUnique({ where: { value: case5TitleA } });
    check("Case 5: trimmed department value cached", cachedDeptA !== null && cachedDeptA.isActive);
    check("Case 5: job title value cached", cachedTitleA !== null && cachedTitleA.isActive);
  } finally {
    // Each step is independently guarded: one cleanup step failing (e.g.
    // the JobTitleValue table not existing yet, pre-migration) must not
    // mask the original test failure or skip $disconnect for the rest.
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: testUserIds } } })],
      ["user", () => prisma.user.deleteMany({ where: { id: { in: testUserIds } } })],
      ["microsoftDepartmentMapping", () =>
        mappingIds.length > 0
          ? prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } })
          : Promise.resolve()],
      ["department", () => (department ? prisma.department.delete({ where: { id: department.id } }) : Promise.resolve())],
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
