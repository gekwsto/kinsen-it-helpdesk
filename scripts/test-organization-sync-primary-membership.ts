/**
 * Microsoft Directory Sync (organization-directory-sync-service.ts) using
 * the new canonical setPrimaryDepartmentMembership() write path — closes the
 * real gap found in the User/Department/Member architecture audit: the
 * multi-company resolver used to write User.departmentId directly, without
 * EVER creating a matching DepartmentMembership. Exercises the REAL
 * runOrganizationDirectorySync() with a mocked Graph `GET /users` response
 * (never a real tenant), same established pattern as
 * scripts/test-organization-multicompany-sync.ts.
 *
 * Tests:
 *  9.  Brand-new Microsoft user: created AND gets an active PRIMARY
 *      DepartmentMembership in the same sync run (not just User.departmentId).
 *  10. Existing Microsoft user whose Graph `department` changes between two
 *      sync runs: primary department switches to the new one.
 *  11. A pre-existing MANUAL secondary membership (a different department
 *      entirely) survives BOTH sync runs completely untouched.
 *  12. The user's OLD Microsoft-owned primary membership (from run 1) is
 *      deactivated (isActive:false) after run 2 moves them elsewhere —
 *      "Microsoft organizational placement δεν πρέπει να αφήνει πίσω παλιό
 *      Microsoft-granted department access χωρίς λόγο."
 *  13. A manually-promoted ADMIN appearing in the sync keeps Role.ADMIN...
 *  14. ...and globalRoleSource stays MANUAL — while their organizational
 *      primary department is STILL correctly updated by the sync (role
 *      protection and department-placement protection are independent).
 *
 * Usage: npx tsx scripts/test-organization-sync-primary-membership.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

import { prisma } from "@/lib/prisma";
import { Role, GlobalRoleSource, MembershipSource } from "@prisma/client";
import { runOrganizationDirectorySync, type GraphDirectoryUser } from "@/lib/services/organization-directory-sync-service";
import { grantManualMembership } from "@/lib/services/department-membership-service";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}`); failed++; }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function installTokenMock(router: (url: string) => Promise<Response> | Response) {
  global.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "mock-app-token" });
    return router(url);
  }) as typeof fetch;
}
function restoreFetch() {
  global.fetch = originalFetch;
}

const companyName = `PrimaryMembership Co ${RUN_ID}`;

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const companyIds: string[] = [];
  const departmentIds: string[] = [];
  let secondaryDept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let manualAdmin: Awaited<ReturnType<typeof prisma.user.create>> | undefined;

  try {
    // ── Fixture: pre-existing user, manually promoted to ADMIN ──────────
    const manualAdminOid = `pm-manual-admin-${RUN_ID}`;
    const manualAdminEmail = `pm-manual-admin-${RUN_ID}@kinsen.gr`;
    manualAdmin = await prisma.user.create({
      data: { email: manualAdminEmail, microsoftUserId: manualAdminOid, role: Role.ADMIN, globalRoleSource: GlobalRoleSource.MANUAL, name: "Manually Promoted Admin" },
    });
    userIds.push(manualAdmin.id);

    // ── Fixture: a department the moving user has a MANUAL secondary membership in ──
    secondaryDept = await prisma.department.create({ data: { name: `PM Secondary Dept ${RUN_ID}`, slug: `pm-secondary-dept-${RUN_ID}` } });
    departmentIds.push(secondaryDept.id);

    const newUserOid = `pm-new-user-${RUN_ID}`;
    const newUserEmail = `pm-new-user-${RUN_ID}@kinsen.gr`;
    const movingUserOid = `pm-moving-user-${RUN_ID}`;
    const movingUserEmail = `pm-moving-user-${RUN_ID}@kinsen.gr`;

    // ── Run 1: brand-new user + a "moving" user starting in "IT" ─────────
    const run1Users: GraphDirectoryUser[] = [
      { id: newUserOid, userType: "Member", mail: newUserEmail, displayName: "New Primary User", companyName, department: "IT", accountEnabled: true },
      { id: movingUserOid, userType: "Member", mail: movingUserEmail, displayName: "Moving User", companyName, department: "IT", accountEnabled: true },
      { id: manualAdminOid, userType: "Member", mail: manualAdminEmail, displayName: "Manually Promoted Admin Updated", companyName, department: "IT", accountEnabled: true },
    ];
    installTokenMock(() => jsonResponse(200, { value: run1Users }));
    const outcome1 = await runOrganizationDirectorySync();
    check("Run 1 completes ok", outcome1.ok === true);

    // ── Test 9: brand-new user gets created AND an active primary membership ──
    const newUser = await prisma.user.findUnique({ where: { microsoftUserId: newUserOid }, select: { id: true, departmentId: true } });
    check("9. Brand-new Microsoft user was created", newUser !== null);
    if (newUser) userIds.push(newUser.id);
    const newUserPrimary = newUser ? await prisma.departmentMembership.findFirst({ where: { userId: newUser.id, isActive: true, isPrimary: true } }) : null;
    check("   ...AND got an active PRIMARY DepartmentMembership in the SAME sync run", newUserPrimary !== null);
    check("   Primary membership's department matches User.departmentId", newUserPrimary?.departmentId === newUser?.departmentId);
    check("   Primary membership source is MICROSOFT_DEPARTMENT", newUserPrimary?.source === MembershipSource.MICROSOFT_DEPARTMENT);

    const movingUser = await prisma.user.findUnique({ where: { microsoftUserId: movingUserOid }, select: { id: true, departmentId: true } });
    check("Moving user was created, placed in IT", movingUser !== null);
    if (movingUser) userIds.push(movingUser.id);
    const itDeptId = movingUser?.departmentId ?? null;
    if (itDeptId) departmentIds.push(itDeptId);
    const movingUserPrimaryRun1 = movingUser ? await prisma.departmentMembership.findFirst({ where: { userId: movingUser.id, isActive: true, isPrimary: true } }) : null;
    check("Moving user's run-1 primary membership is IT, active, MICROSOFT_DEPARTMENT-sourced", movingUserPrimaryRun1?.departmentId === itDeptId && movingUserPrimaryRun1?.source === MembershipSource.MICROSOFT_DEPARTMENT);
    const oldPrimaryMembershipId = movingUserPrimaryRun1?.id;

    // ── Give the moving user a MANUAL secondary membership before run 2 ───
    if (movingUser) {
      const secondary = await grantManualMembership(movingUser.id, secondaryDept.id, { role: "VIEWER" as any });
      check("Manual secondary membership granted before run 2", secondary.source === MembershipSource.MANUAL);
    }

    // ── Test 13/14: manually-promoted admin's global role BEFORE run 2 ────
    const adminBeforeRun2 = await prisma.user.findUnique({ where: { id: manualAdmin.id } });
    check("13a. (pre-check) Manually-promoted admin is ADMIN before run 2", adminBeforeRun2?.role === Role.ADMIN);
    check("14a. (pre-check) globalRoleSource is MANUAL before run 2", adminBeforeRun2?.globalRoleSource === GlobalRoleSource.MANUAL);

    // ── Run 2: moving user's department changes IT -> Sales; admin's dept also updates ──
    const run2Users: GraphDirectoryUser[] = [
      { id: newUserOid, userType: "Member", mail: newUserEmail, displayName: "New Primary User", companyName, department: "IT", accountEnabled: true },
      { id: movingUserOid, userType: "Member", mail: movingUserEmail, displayName: "Moving User", companyName, department: "Sales", accountEnabled: true },
      { id: manualAdminOid, userType: "Member", mail: manualAdminEmail, displayName: "Manually Promoted Admin Updated", companyName, department: "Sales", accountEnabled: true },
    ];
    installTokenMock(() => jsonResponse(200, { value: run2Users }));
    const outcome2 = await runOrganizationDirectorySync();
    check("Run 2 completes ok", outcome2.ok === true);

    // ── Test 10: primary department switched ─────────────────────────────
    const movingUserAfter = await prisma.user.findUnique({ where: { id: movingUser!.id }, select: { departmentId: true } });
    const salesMembership = await prisma.departmentMembership.findFirst({ where: { userId: movingUser!.id, isActive: true, isPrimary: true } });
    check("10. Moving user's primary department switched away from IT", movingUserAfter?.departmentId !== itDeptId);
    check("    New primary membership is active and matches User.departmentId", salesMembership?.departmentId === movingUserAfter?.departmentId);
    if (salesMembership) departmentIds.push(salesMembership.departmentId);

    // ── Test 11: manual secondary membership untouched by either sync run ──
    const secondaryAfter = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: movingUser!.id, departmentId: secondaryDept.id } } });
    check("11. Manual secondary membership (unrelated department) survived BOTH sync runs untouched", secondaryAfter?.isActive === true && secondaryAfter?.source === MembershipSource.MANUAL && secondaryAfter?.isPrimary === false);

    // ── Test 12: old Microsoft-owned primary (IT) deactivated, not left dangling ──
    const oldPrimaryAfter = oldPrimaryMembershipId ? await prisma.departmentMembership.findUnique({ where: { id: oldPrimaryMembershipId } }) : null;
    check("12. Old Microsoft-owned primary (IT) is deactivated after the org move (no stale access left behind)", oldPrimaryAfter?.isActive === false && oldPrimaryAfter?.isPrimary === false);

    // ── Test 13/14: role protection held across the sync that also moved the department ──
    const adminAfterRun2 = await prisma.user.findUnique({ where: { id: manualAdmin.id } });
    check("13. Manually-promoted admin is STILL ADMIN after the sync run", adminAfterRun2?.role === Role.ADMIN);
    check("14. globalRoleSource is STILL MANUAL (role sync never touched it)", adminAfterRun2?.globalRoleSource === GlobalRoleSource.MANUAL);
    check("    ...but the organizational primary department DID still get updated (role protection != department placement protection)", adminAfterRun2?.departmentId !== null && adminAfterRun2?.departmentId === (await prisma.departmentMembership.findFirst({ where: { userId: manualAdmin.id, isActive: true, isPrimary: true } }))?.departmentId);
  } finally {
    restoreFetch();
    console.log("\nCleaning up test data...\n");
    try {
      const allTestUsers = await prisma.user.findMany({ where: { microsoftUserId: { contains: `${RUN_ID}` } }, select: { id: true } });
      const allUserIds = Array.from(new Set([...userIds, ...allTestUsers.map((u) => u.id)]));
      if (allUserIds.length > 0) await prisma.departmentMembership.deleteMany({ where: { userId: { in: allUserIds } } });
      if (allUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });

      const allTestDepartments = await prisma.department.findMany({ where: { name: { contains: `${RUN_ID}` } }, select: { id: true } });
      const allDeptIds = Array.from(new Set([...departmentIds, ...allTestDepartments.map((d) => d.id)]));
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: allDeptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: allDeptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: allDeptIds } } });

      const allTestCompanies = await prisma.company.findMany({ where: { name: { contains: `${RUN_ID}` } }, select: { id: true } });
      const allCompanyIds = Array.from(new Set([...companyIds, ...allTestCompanies.map((c) => c.id)]));
      await prisma.company.deleteMany({ where: { id: { in: allCompanyIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
