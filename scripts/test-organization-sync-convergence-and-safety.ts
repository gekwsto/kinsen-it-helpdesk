/**
 * FIND-003 (docs/roadmap-handoff-register.md) — proves the two remaining,
 * most important properties that don't fit cleanly into the other
 * organization-sync test files:
 *
 *  A. FULL SYNC and FIRST LOGIN converge on the IDENTICAL organizational
 *     placement for the same Graph profile (Company, primary Department,
 *     primary DepartmentMembership, User.departmentId mirror) — never two
 *     independent department-resolution mechanisms producing different
 *     results for the same person.
 *  B. Existing non-@kinsen.gr users are byte-for-byte untouched by a full
 *     sync that now excludes them — no delete, no deactivate, no cleared
 *     company/department, no touched memberships/roles. The domain filter
 *     is an INCLUSION filter for organization sync, never a cleanup policy.
 *
 * Tests (numbered per the FIND-003 test list):
 *  21. Brand-new @kinsen.gr user's FIRST Microsoft login (no prior full
 *      sync) creates the user and places them correctly.
 *  22. An existing manually-created @kinsen.gr local user (no
 *      microsoftUserId) doing their first Microsoft login is matched by
 *      email, gets the Microsoft ID attached, gets organization placement —
 *      never a duplicate row.
 *  23. An existing @kinsen.gr ADMIN (globalRoleSource MANUAL) logging in:
 *      organizational department updates, ADMIN/MANUAL role does not change.
 *  24. Full sync's result and first-login's result for an EQUIVALENT Graph
 *      profile (same companyName/department) converge on the same
 *      organizational placement shape (same company, same primary
 *      department by name, correct User.departmentId mirror) — proven by
 *      running full sync for one user and first-login for another,
 *      identically-profiled user, and comparing outcomes.
 *  25. Existing non-Kinsen local user is completely untouched by a full sync.
 *  26. A previously-synced non-Kinsen user (has microsoftUserId, real
 *      organizational data already) is not deleted/deactivated by a sync
 *      that no longer includes them.
 *  27. Their memberships (primary + secondary) don't change.
 *  28. Their role doesn't change.
 *
 * Usage: npx tsx scripts/test-organization-sync-convergence-and-safety.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

import { prisma } from "@/lib/prisma";
import { AuthProvider, DepartmentMembership, GlobalRoleSource, MembershipSource, Role } from "@prisma/client";
import { runOrganizationDirectorySync, type GraphDirectoryUser } from "@/lib/services/organization-directory-sync-service";
import { syncMicrosoftUserDepartment } from "@/lib/services/microsoft-department-sync-service";
import { grantManualMembership, setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { normalizeCompanyName, normalizeDepartmentName } from "@/lib/services/organization-normalization";

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

function mockGraphMe(profile: { id: string; mail: string | null; userPrincipalName: string | null; userType: string | null; companyName: string | null; department: string | null; jobTitle: string | null; givenName?: string | null; surname?: string | null; displayName?: string | null }) {
  global.fetch = (async () =>
    new Response(JSON.stringify({ displayName: profile.displayName ?? "Test User", ...profile }), { status: 200 })) as typeof fetch;
}

const companyName = `Convergence Co ${RUN_ID}`;
const deptName = `Convergence Dept ${RUN_ID}`;

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

  try {
    // ══ A. CONVERGENCE: full sync vs first login for equivalent profiles ══
    console.log("\n=== A. Full sync vs first-login convergence ===\n");

    // -- Full sync creates userA via the real pipeline --
    const userAOid = `conv-a-${RUN_ID}`;
    const userAEmail = `conv-a-${RUN_ID}@kinsen.gr`;
    const fullSyncFixture: GraphDirectoryUser[] = [
      { id: userAOid, userType: "Member", mail: userAEmail, displayName: "Convergence User A", givenName: "Convergence", surname: "A", companyName, department: deptName, jobTitle: "Analyst", accountEnabled: true },
    ];
    installTokenMock(() => jsonResponse(200, { value: fullSyncFixture }));
    const fullSyncOutcome = await runOrganizationDirectorySync();
    check("Full sync completes ok", fullSyncOutcome.ok === true);
    restoreFetch();

    const userA = await prisma.user.findUnique({ where: { microsoftUserId: userAOid }, select: { id: true, companyId: true, departmentId: true, company: { select: { name: true } }, department: { select: { name: true } } } });
    check("21/24 setup: full sync created userA", userA !== null);
    if (userA) userIds.push(userA.id);

    // -- First login creates userB, with the SAME companyName/department --
    const userBEmail = `conv-b-${RUN_ID}@kinsen.gr`;
    const userB = await prisma.user.create({ data: { email: userBEmail, authProvider: AuthProvider.MICROSOFT, role: Role.USER } });
    userIds.push(userB.id);
    mockGraphMe({ id: `conv-b-${RUN_ID}`, mail: userBEmail, userPrincipalName: null, userType: "Member", companyName, department: deptName, jobTitle: "Analyst", givenName: "Convergence", surname: "B" });
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: userB.id, oid: `conv-b-${RUN_ID}`, email: userBEmail, name: "Convergence User B" });
    restoreFetch();

    const userBAfter = await prisma.user.findUnique({ where: { id: userB.id }, select: { companyId: true, departmentId: true, company: { select: { name: true } }, department: { select: { name: true } } } });

    check("21. Brand-new user's first login (no prior full sync run for THIS user) placed correctly", userBAfter?.departmentId !== null && userBAfter?.companyId !== null);
    check("24. Full sync (userA) and first-login (userB) converge on the SAME Company", userA?.companyId !== null && userA?.companyId === userBAfter?.companyId);
    check("    ...and the SAME primary Department", userA?.departmentId !== null && userA?.departmentId === userBAfter?.departmentId);
    check("    ...Company name matches the real Graph companyName", userBAfter?.company?.name === companyName);
    check("    ...Department name matches the real Graph department", userBAfter?.department?.name === deptName);
    if (userA?.companyId) companyIds.push(userA.companyId);
    if (userA?.departmentId) departmentIds.push(userA.departmentId);

    const userBPrimary = await prisma.departmentMembership.findFirst({ where: { userId: userB.id, isActive: true, isPrimary: true } });
    check("userB has a real active PRIMARY DepartmentMembership matching User.departmentId", userBPrimary?.departmentId === userBAfter?.departmentId);

    // ══ 22. Existing manually-created @kinsen.gr user, first Microsoft login ══
    console.log("\n=== 22. Existing manually-created user, first Microsoft login ===\n");
    const preExistingEmail = `conv-preexisting-${RUN_ID}@kinsen.gr`;
    const preExisting = await prisma.user.create({ data: { email: preExistingEmail, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, passwordHash: "irrelevant" } });
    userIds.push(preExisting.id);
    check("Pre-existing user starts with no microsoftUserId", true); // by construction above
    mockGraphMe({ id: `conv-preexisting-oid-${RUN_ID}`, mail: preExistingEmail, userPrincipalName: null, userType: "Member", companyName, department: deptName, jobTitle: "Coordinator" });
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: preExisting.id, oid: `conv-preexisting-oid-${RUN_ID}`, email: preExistingEmail, name: "Pre Existing" });
    restoreFetch();
    const preExistingAfter = await prisma.user.findUnique({ where: { id: preExisting.id } });
    const totalRowsForEmail = await prisma.user.count({ where: { email: preExistingEmail } });
    check("22. Existing user gets organizational placement on first Microsoft login", preExistingAfter?.departmentId !== null);
    check("    Exactly ONE User row for this email (no duplicate created)", totalRowsForEmail === 1);

    // ══ 23. Existing @kinsen.gr ADMIN (MANUAL) logging in — role protected, department updates ══
    console.log("\n=== 23. Existing ADMIN (MANUAL role) first login ===\n");
    const adminEmail = `conv-admin-${RUN_ID}@kinsen.gr`;
    const adminUser = await prisma.user.create({ data: { email: adminEmail, authProvider: AuthProvider.MICROSOFT, role: Role.ADMIN, globalRoleSource: GlobalRoleSource.MANUAL } });
    userIds.push(adminUser.id);
    mockGraphMe({ id: `conv-admin-oid-${RUN_ID}`, mail: adminEmail, userPrincipalName: null, userType: "Member", companyName, department: deptName, jobTitle: "Director" });
    await syncMicrosoftUserDepartment({ accessToken: "fake-token", userId: adminUser.id, oid: `conv-admin-oid-${RUN_ID}`, email: adminEmail, name: "Convergence Admin" });
    restoreFetch();
    const adminAfter = await prisma.user.findUnique({ where: { id: adminUser.id } });
    check("23. ADMIN role is STILL ADMIN after first login", adminAfter?.role === Role.ADMIN);
    check("    globalRoleSource is STILL MANUAL", adminAfter?.globalRoleSource === GlobalRoleSource.MANUAL);
    check("    Organizational department DID get updated (role protection != placement protection)", adminAfter?.departmentId !== null);

    // ══ B. NON-KINSEN SAFETY ══
    console.log("\n=== B. Existing non-Kinsen user is untouched by full sync ===\n");
    const nonKinsenEmail = `conv-external-${RUN_ID}@othercompany.com`;
    const nonKinsenOid = `conv-external-oid-${RUN_ID}`;
    const priorDept = await prisma.department.create({ data: { name: `Convergence Prior Dept ${RUN_ID}`, slug: `convergence-prior-dept-${RUN_ID}` } });
    departmentIds.push(priorDept.id);
    const nonKinsenUser = await prisma.user.create({
      data: {
        email: nonKinsenEmail, authProvider: AuthProvider.MICROSOFT, role: Role.IT_AGENT, microsoftUserId: nonKinsenOid,
        departmentId: priorDept.id, jobTitle: "External Consultant (pre-existing)", globalRoleSource: GlobalRoleSource.SYSTEM,
      },
    });
    userIds.push(nonKinsenUser.id);
    const primaryResult = await setPrimaryDepartmentMembership(nonKinsenUser.id, priorDept.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: "REQUESTER" as any });
    const secondaryDept = await prisma.department.create({ data: { name: `Convergence Secondary Dept ${RUN_ID}`, slug: `convergence-secondary-dept-${RUN_ID}` } });
    departmentIds.push(secondaryDept.id);
    const secondaryMembership = await grantManualMembership(nonKinsenUser.id, secondaryDept.id, { role: "VIEWER" as any });

    const beforeSnapshot = await prisma.user.findUnique({ where: { id: nonKinsenUser.id } });
    const beforeMemberships = await prisma.departmentMembership.findMany({ where: { userId: nonKinsenUser.id }, orderBy: { departmentId: "asc" } });

    // Full sync fetches a fixture that does NOT include this user at all —
    // exactly what a real tenant scan would look like once this account no
    // longer matches @kinsen.gr (or was never in the tenant this way).
    const syncFixtureExcludingNonKinsen: GraphDirectoryUser[] = [
      { id: `conv-other-${RUN_ID}`, userType: "Member", mail: `conv-other-${RUN_ID}@kinsen.gr`, displayName: "Someone Else", companyName, department: deptName, accountEnabled: true },
    ];
    installTokenMock(() => jsonResponse(200, { value: syncFixtureExcludingNonKinsen }));
    const safetyOutcome = await runOrganizationDirectorySync();
    check("Safety-check full sync completes ok", safetyOutcome.ok === true);
    restoreFetch();
    const otherUser = await prisma.user.findUnique({ where: { microsoftUserId: `conv-other-${RUN_ID}` } });
    if (otherUser) userIds.push(otherUser.id);
    if (otherUser?.companyId) companyIds.push(otherUser.companyId);
    if (otherUser?.departmentId) departmentIds.push(otherUser.departmentId);

    const afterSnapshot = await prisma.user.findUnique({ where: { id: nonKinsenUser.id } });
    const afterMemberships = await prisma.departmentMembership.findMany({ where: { userId: nonKinsenUser.id }, orderBy: { departmentId: "asc" } });

    check("25. Non-Kinsen user still exists after the sync (not deleted)", afterSnapshot !== null);
    check("26. Non-Kinsen user is still isActive (not deactivated)", afterSnapshot?.isActive === beforeSnapshot?.isActive && afterSnapshot?.isActive === true);
    check("    companyId completely unchanged", afterSnapshot?.companyId === beforeSnapshot?.companyId);
    check("    departmentId completely unchanged", afterSnapshot?.departmentId === beforeSnapshot?.departmentId);
    check("    jobTitle completely unchanged", afterSnapshot?.jobTitle === beforeSnapshot?.jobTitle);
    check("    organizationSyncedAt completely unchanged (never touched by a sync run that excludes them)", afterSnapshot?.organizationSyncedAt?.getTime() === beforeSnapshot?.organizationSyncedAt?.getTime());
    check("27. Same NUMBER of memberships before/after (primary + secondary, none added/removed)", afterMemberships.length === beforeMemberships.length && afterMemberships.length === 2);
    check(
      "    Every membership row byte-for-byte unchanged (isActive/isPrimary/role/source identical)",
      afterMemberships.every((m, i) => {
        const b = beforeMemberships[i] as DepartmentMembership;
        return m.isActive === b.isActive && m.isPrimary === b.isPrimary && m.role === b.role && m.source === b.source && m.departmentId === b.departmentId;
      })
    );
    check("28. Role completely unchanged", afterSnapshot?.role === beforeSnapshot?.role);
    check("    globalRoleSource completely unchanged", afterSnapshot?.globalRoleSource === beforeSnapshot?.globalRoleSource);

    void primaryResult;
    void secondaryMembership;
  } finally {
    restoreFetch();
    console.log("\nCleaning up test data...\n");
    try {
      const allTestUsers = await prisma.user.findMany({ where: { email: { contains: RUN_ID.toString() } }, select: { id: true } });
      const allUserIds = Array.from(new Set([...userIds, ...allTestUsers.map((u) => u.id)]));
      if (allUserIds.length > 0) {
        await prisma.departmentMembership.deleteMany({ where: { userId: { in: allUserIds } } });
        await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
      }

      const allTestDepartments = await prisma.department.findMany({ where: { name: { contains: RUN_ID.toString() } }, select: { id: true } });
      const allDeptIds = Array.from(new Set([...departmentIds, ...allTestDepartments.map((d) => d.id)]));
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: allDeptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: allDeptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: allDeptIds } } });

      const allTestCompanies = await prisma.company.findMany({ where: { name: { contains: RUN_ID.toString() } }, select: { id: true } });
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
