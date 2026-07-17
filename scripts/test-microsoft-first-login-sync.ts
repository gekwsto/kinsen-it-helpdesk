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
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";

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
const testUserIds: string[] = [];

function mockGraphMeOnce(department: string | null, oid = `test-oid-${RUN_ID}`) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response(
      JSON.stringify({
        id: oid,
        displayName: "Test User",
        mail: null,
        userPrincipalName: null,
        department,
        jobTitle: null,
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

  const department = await prisma.department.create({
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

  try {
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
  } finally {
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    await prisma.microsoftDepartmentMapping.delete({ where: { id: mapping.id } });
    await prisma.department.delete({ where: { id: department.id } });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
