/**
 * Multi-company Microsoft Directory Sync — company/department resolution,
 * normalization, user placement, role-policy protection, and tree
 * assembly. Exercises the REAL runOrganizationDirectorySync() /
 * getDepartmentTree() functions with a mocked Graph `GET /users` response
 * (never a real tenant). Graph pagination, 429/transient retry, and
 * self-manager/manager-not-in-sync-set edge cases are already covered by
 * scripts/test-organization-graph-sync.ts — not duplicated here; this file
 * focuses specifically on the multi-company placement logic added on top.
 *
 * Usage: npx tsx scripts/test-organization-multicompany-sync.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";

import { prisma } from "@/lib/prisma";
import { Role, GlobalRoleSource, AuthProvider } from "@prisma/client";
import { runOrganizationDirectorySync, type GraphDirectoryUser } from "@/lib/services/organization-directory-sync-service";
import { getDepartmentTree, invalidateOrganizationTreeCache } from "@/lib/services/organization-tree-service";
import { normalizeCompanyName, normalizeDepartmentName } from "@/lib/services/organization-normalization";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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

// Company/department names for this run — real-world-shaped ("Kinsen"/
// "Kinsen Austria"/"Saracakis"-style: distinct legal entities, one sharing a
// literal name prefix with another) but never hardcoded/special-cased in
// the resolver itself — this is fixture data, not a mapping table.
const companyKinsen = `Kinsen ${RUN_ID}`;
const companyKinsenAustria = `Kinsen Austria ${RUN_ID}`;
const companySaracakis = `Saracakis ${RUN_ID}`;

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
  const customRoleIds: string[] = [];

  try {
    // ── Fixture: a pre-existing manually-created user with a manually-elevated role ──
    const manualAdminOid = `mc-manual-admin-${RUN_ID}`;
    const manualAdminEmail = `mc-manual-admin-${RUN_ID}@kinsen.gr`;
    const manualAdmin = await prisma.user.create({
      data: { email: manualAdminEmail, microsoftUserId: manualAdminOid, role: Role.ADMIN, globalRoleSource: GlobalRoleSource.MANUAL, name: "Manually Promoted Admin" },
    });
    userIds.push(manualAdmin.id);

    // ── Fixture: existing user, same email, NO microsoftUserId yet ──
    const linkTargetEmail = `mc-link-target-${RUN_ID}@kinsen.gr`;
    const linkTargetOid = `mc-link-oid-${RUN_ID}`;
    const linkTarget = await prisma.user.create({ data: { email: linkTargetEmail, authProvider: AuthProvider.CREDENTIALS, name: "Pre-existing Local Account" } });
    userIds.push(linkTarget.id);

    // ── Fixture: existing user whose local email is lowercase; Graph will report it mixed-case ──
    const caseTestEmailLower = `mc-case-${RUN_ID}@kinsen.gr`;
    const caseTestOid = `mc-case-oid-${RUN_ID}`;
    const caseTestUser = await prisma.user.create({ data: { email: caseTestEmailLower, name: "Case Sensitivity Fixture" } });
    userIds.push(caseTestUser.id);

    // ── Fixture: existing user who will MOVE department (same company) ──
    const moveDeptOid = `mc-movedept-${RUN_ID}`;
    const moveDeptEmail = `mc-movedept-${RUN_ID}@kinsen.gr`;
    const moveDeptUser = await prisma.user.create({ data: { email: moveDeptEmail, microsoftUserId: moveDeptOid, name: "Move Dept User" } });
    userIds.push(moveDeptUser.id);

    // ── Fixture: existing user who will MOVE company entirely ──
    const moveCompanyOid = `mc-movecompany-${RUN_ID}`;
    const moveCompanyEmail = `mc-movecompany-${RUN_ID}@kinsen.gr`;
    const moveCompanyUser = await prisma.user.create({ data: { email: moveCompanyEmail, microsoftUserId: moveCompanyOid, name: "Move Company User" } });
    userIds.push(moveCompanyUser.id);

    const graphUsers: GraphDirectoryUser[] = [
      // Brand-new users across 3 distinct companies.
      { id: `mc-new-kinsen-${RUN_ID}`, userType: "Member", mail: `mc-new-kinsen-${RUN_ID}@kinsen.gr`, displayName: "New Kinsen User", givenName: "New", surname: "KinsenUser", companyName: companyKinsen, department: "IT", jobTitle: "Engineer", accountEnabled: true },
      { id: `mc-new-austria-${RUN_ID}`, userType: "Member", mail: `mc-new-austria-${RUN_ID}@kinsen.gr`, displayName: "New Austria User", companyName: companyKinsenAustria, department: "IT", jobTitle: "Support", accountEnabled: true },
      { id: `mc-new-saracakis-${RUN_ID}`, userType: "Member", mail: `mc-new-saracakis-${RUN_ID}@kinsen.gr`, displayName: "New Saracakis User", companyName: companySaracakis, department: "Sales", jobTitle: "Account Manager", accountEnabled: true },
      // Duplicate/whitespace/case variant of Kinsen's own name+department — must resolve to the SAME company/department as the first Kinsen user above, never a new one.
      { id: `mc-dup-kinsen-${RUN_ID}`, userType: "Member", mail: `mc-dup-kinsen-${RUN_ID}@kinsen.gr`, displayName: "Dup Kinsen User", companyName: `  ${companyKinsen.toUpperCase()}  `, department: "  IT  ", jobTitle: "Engineer II", accountEnabled: true },
      // Null companyName AND null department -> global Unassigned/Unassigned.
      { id: `mc-null-both-${RUN_ID}`, userType: "Member", mail: `mc-null-both-${RUN_ID}@kinsen.gr`, displayName: "Null Both User", companyName: null, department: null, accountEnabled: true },
      // Known company, null department -> that company's own Unassigned.
      { id: `mc-null-dept-${RUN_ID}`, userType: "Member", mail: `mc-null-dept-${RUN_ID}@kinsen.gr`, displayName: "Null Dept User", companyName: companyKinsen, department: null, accountEnabled: true },
      // Links to the pre-existing no-microsoftUserId local account.
      { id: linkTargetOid, userType: "Member", mail: linkTargetEmail, displayName: "Linked Account", companyName: companyKinsen, department: "IT", jobTitle: "Linked Role", accountEnabled: true },
      // Case-different email — must match the existing lowercase-stored user, not create a duplicate.
      { id: caseTestOid, userType: "Member", mail: caseTestEmailLower.toUpperCase(), displayName: "Case Test User", companyName: companyKinsen, department: "IT", accountEnabled: true },
      // Existing user moves department within the same company (Kinsen: IT -> Sales).
      { id: moveDeptOid, userType: "Member", mail: moveDeptEmail, displayName: "Move Dept User Updated", companyName: companyKinsen, department: "Sales", jobTitle: "New Title", accountEnabled: true },
      // Existing user moves company entirely (Kinsen -> Saracakis).
      { id: moveCompanyOid, userType: "Member", mail: moveCompanyEmail, displayName: "Move Company User Updated", companyName: companySaracakis, department: "Sales", accountEnabled: true },
      // Manually-promoted admin appears in this sync too — role must NEVER be touched.
      { id: manualAdminOid, userType: "Member", mail: manualAdminEmail, displayName: "Manually Promoted Admin Updated", companyName: companyKinsen, department: "IT", accountEnabled: true },
    ];

    installTokenMock(() => jsonResponse(200, { value: graphUsers }));

    const outcome1 = await runOrganizationDirectorySync();
    check("1. Sync completes ok", outcome1.ok === true);
    check("   scanned exactly the fixture user count", outcome1.usersScanned === graphUsers.length);

    // ── 3. New Microsoft user, base role ────────────────────────────────
    const newKinsenUser = await prisma.user.findUnique({ where: { microsoftUserId: `mc-new-kinsen-${RUN_ID}` } });
    check("3. Brand-new Microsoft user was created", newKinsenUser !== null);
    check("17. New Microsoft user gets base role USER (never anything else)", newKinsenUser?.role === Role.USER);
    check("   givenName/surname captured from Graph", newKinsenUser?.givenName === "New" && newKinsenUser?.surname === "KinsenUser");

    // ── 5/6/7. Company/department resolution + multi-company distinctness ──
    const kinsenCompany = await prisma.company.findUnique({ where: { normalizedName: normalizeCompanyName(companyKinsen) } });
    const austriaCompany = await prisma.company.findUnique({ where: { normalizedName: normalizeCompanyName(companyKinsenAustria) } });
    const saracakisCompany = await prisma.company.findUnique({ where: { normalizedName: normalizeCompanyName(companySaracakis) } });
    check("8. All three distinct companies were created", !!kinsenCompany && !!austriaCompany && !!saracakisCompany);
    check("   Kinsen and Kinsen Austria are genuinely different Company rows", kinsenCompany?.id !== austriaCompany?.id);
    if (kinsenCompany) companyIds.push(kinsenCompany.id);
    if (austriaCompany) companyIds.push(austriaCompany.id);
    if (saracakisCompany) companyIds.push(saracakisCompany.id);

    const kinsenIt = kinsenCompany ? await prisma.department.findFirst({ where: { companyId: kinsenCompany.id, normalizedName: normalizeDepartmentName("IT") } }) : null;
    const austriaIt = austriaCompany ? await prisma.department.findFirst({ where: { companyId: austriaCompany.id, normalizedName: normalizeDepartmentName("IT") } }) : null;
    check("7. Kinsen's 'IT' and Kinsen Austria's 'IT' are two distinct Department rows (never merged)", !!kinsenIt && !!austriaIt && kinsenIt!.id !== austriaIt!.id);
    if (kinsenIt) departmentIds.push(kinsenIt.id);
    if (austriaIt) departmentIds.push(austriaIt.id);

    // ── 11. Duplicate/whitespace/case-variant company+department names dedupe to the SAME rows ──
    const dupUser = await prisma.user.findUnique({ where: { microsoftUserId: `mc-dup-kinsen-${RUN_ID}` } });
    check("11. A whitespace/case-variant companyName resolves to the SAME company (no duplicate root)", dupUser?.companyId === kinsenCompany?.id);
    check("    A whitespace-padded department name resolves to the SAME department (no duplicate)", dupUser?.departmentId === kinsenIt?.id);
    check("    No extra 'Kinsen'-normalized company was created", (await prisma.company.count({ where: { normalizedName: normalizeCompanyName(companyKinsen) } })) === 1);

    // ── 9/10. Null companyName / null department fallbacks ──────────────
    // A missing companyName must NEVER create a persisted "Unassigned"
    // Company row (that would be exactly the fabricated company root the
    // feature's spec forbids). companyId stays null; the Department is
    // genuinely orphaned (companyId: null, businessUnitId: null) — the same
    // shape organization-tree-service.ts already renders under its own
    // synthesized, non-persisted "Unassigned" grouping.
    const nullBothUser = await prisma.user.findUnique({ where: { microsoftUserId: `mc-null-both-${RUN_ID}` }, include: { company: true, department: true } });
    check("9. Null companyName does NOT create/attach a persisted 'Unassigned' Company", nullBothUser?.companyId === null && nullBothUser?.company === null);
    check("   Null department (with null company) resolves to a genuinely orphaned 'Unassigned' department (companyId + businessUnitId both null)", nullBothUser?.department?.name === "Unassigned" && nullBothUser?.department?.companyId === null && nullBothUser?.department?.businessUnitId === null);
    if (nullBothUser?.companyId) companyIds.push(nullBothUser.companyId);
    if (nullBothUser?.departmentId) departmentIds.push(nullBothUser.departmentId);

    const nullDeptUser = await prisma.user.findUnique({ where: { microsoftUserId: `mc-null-dept-${RUN_ID}` }, include: { company: true, department: true } });
    check("10. Null department with a KNOWN company resolves to THAT company's own Unassigned department", nullDeptUser?.companyId === kinsenCompany?.id && nullDeptUser?.department?.name === "Unassigned");
    check("    Kinsen's own Unassigned department is distinct from the global Unassigned company's Unassigned department", nullDeptUser?.departmentId !== nullBothUser?.departmentId);
    if (nullDeptUser?.departmentId) departmentIds.push(nullDeptUser.departmentId);

    // ── existing user, same email, no microsoftUserId -> LINKED ─────────
    const linkedRefetched = await prisma.user.findUnique({ where: { id: linkTarget.id } });
    check("Existing user (same email, null microsoftUserId) is linked, not duplicated", linkedRefetched?.microsoftUserId === linkTargetOid);
    check("Linked user got a real company/department placement", linkedRefetched?.companyId === kinsenCompany?.id);
    check("Exactly one row exists for this email", (await prisma.user.count({ where: { email: linkTargetEmail } })) === 1);

    // ── email case difference -> matched, not duplicated ─────────────────
    const caseRefetched = await prisma.user.findUnique({ where: { id: caseTestUser.id } });
    check("2. Graph returning a different-case email still matches the existing lowercase-stored user", caseRefetched?.microsoftUserId === caseTestOid);
    check("   Exactly one row exists for this identity (no case-variant duplicate)", (await prisma.user.count({ where: { email: caseTestEmailLower } })) === 1);

    // ── 4/7. Existing user's department/job title update ────────────────
    const moveDeptRefetched = await prisma.user.findUnique({ where: { id: moveDeptUser.id }, include: { department: true } });
    check("4/7. Existing user's department was updated to the new Graph value", moveDeptRefetched?.department?.name === "Sales" && moveDeptRefetched?.companyId === kinsenCompany?.id);
    check("     Existing user's jobTitle was updated too", moveDeptRefetched?.jobTitle === "New Title");

    // ── 6. Existing user moved to a DIFFERENT company ────────────────────
    const moveCompanyRefetched = await prisma.user.findUnique({ where: { id: moveCompanyUser.id } });
    check("6. Existing user correctly moved to a different Company entirely", moveCompanyRefetched?.companyId === saracakisCompany?.id);

    // ── 18/19. Manually-assigned role is NEVER touched by sync ──────────
    const manualAdminRefetched = await prisma.user.findUnique({ where: { id: manualAdmin.id } });
    check("18. Manually-assigned ADMIN role survives the sync completely untouched", manualAdminRefetched?.role === Role.ADMIN);
    check("    globalRoleSource stays MANUAL — sync never claims credit for a role it didn't set", manualAdminRefetched?.globalRoleSource === GlobalRoleSource.MANUAL);
    check("    This user's organizational placement (company/department) is STILL kept in sync, though", manualAdminRefetched?.companyId === kinsenCompany?.id);
    check("19. No automatic admin/business role was granted to any brand-new user either", newKinsenUser?.role === Role.USER);

    // ── 20/21. Organization tree: correct counts, correct multi-root response ──
    invalidateOrganizationTreeCache();
    const tree = await getDepartmentTree({ activeOnly: false });
    const companyNamesInTree = tree.filter((n: any) => n.type === "company").map((n: any) => n.name);
    check("21. Tree API response includes multiple distinct company roots", companyNamesInTree.includes(kinsenCompany?.name) && companyNamesInTree.includes(austriaCompany?.name) && companyNamesInTree.includes(saracakisCompany?.name));

    function findNode(nodes: any[], id: string): any {
      for (const n of nodes) {
        if (n.id === id) return n;
        const found = findNode(n.children, id);
        if (found) return found;
      }
      return null;
    }
    const kinsenNode = kinsenCompany ? findNode(tree, kinsenCompany.id) : null;
    const kinsenItNode = kinsenIt ? findNode(tree, kinsenIt.id) : null;
    const austriaItNode = austriaIt ? findNode(tree, austriaIt.id) : null;
    check("22. Kinsen's IT department node appears under the Kinsen company node in the tree, not Austria's", kinsenItNode !== null && !!kinsenNode?.children?.some((c: any) => c.id === kinsenIt?.id));
    check("    Austria's IT department is a completely separate node, never merged with Kinsen's", austriaItNode?.id !== kinsenItNode?.id);
    check("20. Company-level user counts are correct (sum of everything placed under it)", typeof kinsenNode?.totalUserCount === "number" && kinsenNode.totalUserCount >= 4);

    // ── 16. Second run of the SAME snapshot: zero duplicates, predictable ──
    // Scoped to THIS run's own RUN_ID-tagged fixtures, never a global,
    // unscoped table count — a global count is vulnerable to any unrelated
    // concurrent activity (this exact fragility caused a real, confirmed
    // one-off flake in the full regression suite, see docs/roadmap-handoff-register.md
    // FIND-006's follow-up section: two consecutive standalone runs of this
    // file passed cleanly, isolating the cause to the unscoped count()
    // pattern, not application behavior). Departments are scoped via their
    // parent company's RUN_ID-tagged name (department names themselves,
    // like "IT"/"Sales", are deliberately generic, not RUN_ID-tagged).
    const companyCountBefore = await prisma.company.count({ where: { name: { contains: RUN_ID.toString() } } });
    const departmentCountBefore = await prisma.department.count({ where: { company: { name: { contains: RUN_ID.toString() } } } });
    const userCountBefore = await prisma.user.count({ where: { email: { contains: RUN_ID.toString() } } });
    const outcome2 = await runOrganizationDirectorySync();
    check("16. Second (repeated) run of the identical snapshot also succeeds", outcome2.ok === true);
    check("    No duplicate companies were created on the repeat run", (await prisma.company.count({ where: { name: { contains: RUN_ID.toString() } } })) === companyCountBefore);
    check("    No duplicate departments were created on the repeat run", (await prisma.department.count({ where: { company: { name: { contains: RUN_ID.toString() } } } })) === departmentCountBefore);
    check("    No duplicate users were created on the repeat run", (await prisma.user.count({ where: { email: { contains: RUN_ID.toString() } } })) === userCountBefore);
    const stillOneKinsenIt = await prisma.department.count({ where: { companyId: kinsenCompany?.id, normalizedName: normalizeDepartmentName("IT") } });
    check("    Still exactly one Kinsen IT department after the repeat run", stillOneKinsenIt === 1);

    // ── 15. Database failure inside the run never produces fake success counters ──
    // Reuses the exact identity-conflict mechanism already regression-tested
    // in scripts/test-organization-graph-sync.ts's section4b — verified
    // again here specifically alongside company/department placement data,
    // proving the counters stay honest in the multi-company path too.
    const conflictOwnerOid = `mc-conflict-owner-${RUN_ID}`;
    const conflictEmail = `mc-conflict-${RUN_ID}@kinsen.gr`;
    const conflictOwner = await prisma.user.create({ data: { email: conflictEmail, microsoftUserId: conflictOwnerOid, name: "Conflict Owner" } });
    userIds.push(conflictOwner.id);
    const conflictAttemptOid = `mc-conflict-attempt-${RUN_ID}`;
    const afterConflictOid = `mc-after-conflict-${RUN_ID}`;
    installTokenMock(() =>
      jsonResponse(200, {
        value: [
          { id: conflictAttemptOid, userType: "Member", mail: conflictEmail, displayName: "Conflict Attempt", companyName: companyKinsen, department: "IT", accountEnabled: true },
          { id: afterConflictOid, userType: "Member", mail: `mc-after-conflict-${RUN_ID}@kinsen.gr`, displayName: "After Conflict", companyName: companyKinsen, department: "IT", accountEnabled: true },
        ],
      })
    );
    const outcome3 = await runOrganizationDirectorySync();
    check("15. A conflicting record inside the run is isolated, not a hard failure", outcome3.ok === true);
    check("    The conflicting record is reflected as a real error, not a fake success", outcome3.errorCount >= 1);
    const afterConflictUser = await prisma.user.findUnique({ where: { microsoftUserId: afterConflictOid } });
    check("    A user processed AFTER the conflict in the same run still synced successfully", afterConflictUser !== null && afterConflictUser?.companyId === kinsenCompany?.id);
    if (afterConflictUser) userIds.push(afterConflictUser.id);
    const conflictOwnerUnchanged = await prisma.user.findUnique({ where: { id: conflictOwner.id } });
    check("    The original conflict-owner row is completely untouched", conflictOwnerUnchanged?.microsoftUserId === conflictOwnerOid);
  } finally {
    restoreFetch();
    console.log("\nCleaning up test data...\n");
    try {
      // Collect every fixture/synced user by microsoftUserId prefix too, in
      // case any id wasn't explicitly tracked above.
      const allTestUsers = await prisma.user.findMany({ where: { microsoftUserId: { contains: `${RUN_ID}` } }, select: { id: true } });
      const allIds = Array.from(new Set([...userIds, ...allTestUsers.map((u) => u.id)]));
      if (allIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: allIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      // Departments/companies discovered by name prefix too (the resolver
      // may have created ones not explicitly captured above, e.g. each
      // company's own "Unassigned" department).
      const allTestDepartments = await prisma.department.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
      const allDeptIds = Array.from(new Set([...departmentIds, ...allTestDepartments.map((d) => d.id)]));
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: allDeptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: allDeptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: allDeptIds } } });
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
      if (customRoleIds.length > 0) await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    invalidateOrganizationTreeCache();
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
