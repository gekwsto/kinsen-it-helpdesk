/**
 * Explicit test for Global Role vs Department Role independence, per the
 * production-readiness audit's requirement: "Πρόσθεσε tests για σύγκρουση
 * Global Role και Department Role mappings."
 *
 * The two layers are resolved by DIFFERENT functions over the SAME set of
 * matched MicrosoftDepartmentMapping rows:
 *   - resolveDepartmentMemberships() -> one (department, departmentRole) tuple
 *     PER matched department (grouped by department, highest-priority source wins).
 *   - resolvePrimaryMicrosoftMapping() -> the single highest-priority mapping
 *     ROW across ALL matches (not grouped by department) -> drives User.role.
 *
 * This means a user can legitimately end up with:
 *   - User.role (global) taken from mapping M1 (department A's mapping, say
 *     it's the higher-priority ENTRA_APP_ROLE signal)
 *   - DepartmentMembership role in a DIFFERENT department B, from a lower-
 *     priority PROFILE_DEPARTMENT mapping M2
 * without either layer leaking into or overwriting the other. This is
 * exercised end-to-end via syncMicrosoftUserDepartment (real DB, mocked
 * Graph /me), not just the two resolver functions in isolation, since the
 * bug this guards against would only show up in how the two writes combine.
 *
 * Usage: npx tsx scripts/test-microsoft-global-vs-department-role-conflict.ts
 */
import { prisma } from "@/lib/prisma";
import { DepartmentRole, GlobalRoleSource, MembershipSource, MicrosoftMappingSourceType, Role, AuthProvider } from "@prisma/client";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { createMapping } from "@/lib/services/microsoft-mapping-service";

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

function mockGraphMe(department: string | null, oid: string, jobTitle: string | null = null, groups?: string[], roles?: string[]) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({ id: oid, displayName: "Test User", mail: null, userPrincipalName: null, department, jobTitle }),
      { status: 200 }
    )) as typeof fetch;
  return { groups, roles };
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

  let deptA: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let deptB: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  const mappingIds: string[] = [];
  const testUserIds: string[] = [];

  try {
    deptA = await prisma.department.create({ data: { name: `Test Conflict Dept A ${RUN_ID}`, slug: `test-conflict-a-${RUN_ID}` } });
    deptB = await prisma.department.create({ data: { name: `Test Conflict Dept B ${RUN_ID}`, slug: `test-conflict-b-${RUN_ID}` } });

    const DEPT_A_VALUE = `Test Conflict A Value ${RUN_ID}`;
    const DEPT_B_JOB_TITLE = `Test Conflict B Job Title ${RUN_ID}`;

    // M1: department-only mapping for A. Global role USER, department role VIEWER.
    // Lowest priority source type (PROFILE_DEPARTMENT = 1).
    const m1 = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: DEPT_A_VALUE,
      departmentId: deptA.id,
      role: Role.USER,
      departmentRole: DepartmentRole.VIEWER,
    });
    mappingIds.push(m1.id);

    // M2: job-title mapping for B. Global role DEPARTMENT_MANAGER, department
    // role DEPARTMENT_MANAGER. Higher priority source type (PROFILE_JOB_TITLE = 2)
    // — this is the one that should win the GLOBAL role, even though it's a
    // DIFFERENT department than A.
    const m2 = await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
      microsoftValue: DEPT_B_JOB_TITLE,
      departmentId: deptB.id,
      role: Role.DEPARTMENT_MANAGER,
      departmentRole: DepartmentRole.DEPARTMENT_MANAGER,
    });
    mappingIds.push(m2.id);

    console.log("Test 1: user matches BOTH mappings in one login — global role comes from the HIGHER-priority mapping (M2/dept B), department roles are set independently per department\n");
    const user1 = await prisma.user.create({ data: { email: `test-conflict-1-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT } });
    testUserIds.push(user1.id);
    mockGraphMe(DEPT_A_VALUE, `test-conflict-oid-1-${RUN_ID}`, DEPT_B_JOB_TITLE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: user1.id,
      oid: `test-conflict-oid-1-${RUN_ID}`,
      email: user1.email,
      name: "Test User",
    });

    const user1After = await prisma.user.findUnique({ where: { id: user1.id } });
    const membershipA = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: deptA.id } } });
    const membershipB = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: deptB.id } } });

    check("Global User.role === DEPARTMENT_MANAGER (from the higher-priority M2/dept B mapping)", user1After?.role === Role.DEPARTMENT_MANAGER);
    check("globalRoleMicrosoftMappingId points at M2 (dept B's mapping), not M1", user1After?.globalRoleMicrosoftMappingId === m2.id);
    check("Department A membership exists with its OWN role (VIEWER) from M1 — unaffected by the global-role winner being M2", membershipA?.role === DepartmentRole.VIEWER);
    check("Department A membership source is MICROSOFT_DEPARTMENT (from M1, not overwritten by M2's source type)", membershipA?.source === MembershipSource.MICROSOFT_DEPARTMENT);
    check("Department B membership exists with its OWN role (DEPARTMENT_MANAGER) from M2", membershipB?.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("Department B membership source is MICROSOFT_JOB_TITLE", membershipB?.source === MembershipSource.MICROSOFT_JOB_TITLE);
    check("User has membership rows in BOTH departments simultaneously (multi-department membership)", membershipA !== null && membershipB !== null);

    console.log("\nTest 2: changing M1's department role (dept A) does NOT affect dept B's already-resolved role or the global role\n");
    const { updateMapping } = await import("@/lib/services/microsoft-mapping-service");
    await updateMapping(m1.id, { departmentRole: DepartmentRole.AGENT_ASSIGNEE });
    mockGraphMe(DEPT_A_VALUE, `test-conflict-oid-1-${RUN_ID}`, DEPT_B_JOB_TITLE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: user1.id,
      oid: `test-conflict-oid-1-${RUN_ID}`,
      email: user1.email,
      name: "Test User",
    });
    const membershipAAfterEdit = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: deptA.id } } });
    const membershipBAfterEdit = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: deptB.id } } });
    const user1AfterEdit = await prisma.user.findUnique({ where: { id: user1.id } });
    check("Dept A's role updated to the new value (AGENT_ASSIGNEE) on re-sync", membershipAAfterEdit?.role === DepartmentRole.AGENT_ASSIGNEE);
    check("Dept B's role is COMPLETELY UNCHANGED by editing M1 (still DEPARTMENT_MANAGER)", membershipBAfterEdit?.role === DepartmentRole.DEPARTMENT_MANAGER);
    check("Global role is COMPLETELY UNCHANGED by editing M1's department role (still DEPARTMENT_MANAGER from M2)", user1AfterEdit?.role === Role.DEPARTMENT_MANAGER);

    console.log("\nTest 3: a SEPARATE user who only matches the LOWER-priority mapping (M1/dept A) gets the global role from M1 — proves priority isn't a fixed department, it's per-login based on which mappings actually matched\n");
    const user2 = await prisma.user.create({ data: { email: `test-conflict-2-${RUN_ID}@kinsen.gr`, authProvider: AuthProvider.MICROSOFT } });
    testUserIds.push(user2.id);
    mockGraphMe(DEPT_A_VALUE, `test-conflict-oid-2-${RUN_ID}`, null); // no job title -> M2 never matches for this user
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: user2.id,
      oid: `test-conflict-oid-2-${RUN_ID}`,
      email: user2.email,
      name: "Test User 2",
    });
    const user2After = await prisma.user.findUnique({ where: { id: user2.id } });
    const user2MembershipB = await prisma.departmentMembership.count({ where: { userId: user2.id, departmentId: deptB.id } });
    check("User 2's global role comes from M1 (USER) since M2 never matched for them", user2After?.role === Role.USER);
    check("User 2 has NO membership in dept B at all (M2 never matched)", user2MembershipB === 0);
    check("User 1's global role (from Test 2) is unaffected by User 2's independent sync", (await prisma.user.findUnique({ where: { id: user1.id } }))?.role === Role.DEPARTMENT_MANAGER);

    console.log("\nTest 4: disabling M2 (dept B's mapping) — re-sync drops dept B membership (soft-revoke) and the global role falls back to M1, without touching dept A's row\n");
    await updateMapping(m2.id, { isActive: false });
    mockGraphMe(DEPT_A_VALUE, `test-conflict-oid-1-${RUN_ID}`, DEPT_B_JOB_TITLE);
    await syncMicrosoftUserDepartment({
      accessToken: "fake-token",
      userId: user1.id,
      oid: `test-conflict-oid-1-${RUN_ID}`,
      email: user1.email,
      name: "Test User",
    });
    const user1AfterDisable = await prisma.user.findUnique({ where: { id: user1.id } });
    const membershipBAfterDisable = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: deptB.id } } });
    const membershipAAfterDisable = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: user1.id, departmentId: deptA.id } } });
    check("Global role falls back to M1 (USER) once M2 is disabled and no longer matches", user1AfterDisable?.role === Role.USER);
    check("Dept B membership is soft-revoked (isActive: false), not deleted", membershipBAfterDisable?.isActive === false);
    check("Dept A membership is completely untouched by M2 being disabled (still AGENT_ASSIGNEE, still active)", membershipAAfterDisable?.role === DepartmentRole.AGENT_ASSIGNEE && membershipAAfterDisable?.isActive === true);
  } finally {
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["departmentMembership", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: testUserIds } } })],
      ["user", () => prisma.user.deleteMany({ where: { id: { in: testUserIds } } })],
      ["microsoftDepartmentMapping", () => (mappingIds.length > 0 ? prisma.microsoftDepartmentMapping.deleteMany({ where: { id: { in: mappingIds } } }) : Promise.resolve())],
      ["department", () => prisma.department.deleteMany({ where: { id: { in: [deptA?.id, deptB?.id].filter((x): x is string => !!x) } } })],
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
