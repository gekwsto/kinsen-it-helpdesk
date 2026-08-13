/**
 * Regression coverage for the "Viewer -> custom department role does not
 * persist" production bug — a READ/SERIALIZATION bug, not a write/DB
 * persistence bug (the previous department-role-persistence fix session's
 * 24/24 tests all exercised the service layer directly against Prisma;
 * none of them exercised lib/services/admin-user-list-query.ts's
 * ADMIN_USER_LIST_SELECT — the exact query app/(main)/admin/users/page.tsx
 * uses on every page load AND every router.refresh() call, which is what
 * the real Edit User dialog's `users` state is actually rebuilt from).
 *
 * ROOT CAUSE: ADMIN_USER_LIST_SELECT's `departmentMemberships.select`
 * omitted `customRoleId`/`customRole` entirely. A department membership
 * assigned a CUSTOM role stores its real identity in `customRoleId`
 * (`role` is a required-but-unused VIEWER placeholder — see
 * grantManualMembership's schema comment) — so any client state rebuilt
 * from this query had `customRoleId` silently `undefined`, and
 * components/admin/user-department-memberships.tsx's
 * `membershipRoleValue(m) = m.customRoleId ? \`custom:${m.customRoleId}\` : m.role`
 * fell back to displaying the enum placeholder ("Viewer") — even though
 * the database's DepartmentMembership row was always correctly persisted.
 * The database was never wrong; the read path just never asked for the
 * field that proves it. This is exactly why the change "looked like it
 * didn't persist": it displayed correctly immediately after the POST
 * (built from the POST's own response, not this query), then reverted to
 * "Viewer" the moment ANYTHING re-ran this Server Component (a real
 * browser reload, or router.refresh() — called after every outer Edit
 * User Save).
 *
 * FIX: lib/services/admin-user-list-query.ts's ADMIN_USER_LIST_SELECT now
 * selects customRoleId + customRole (id/name/isActive), matching
 * USER_INCLUDE's shape (used by the PATCH/POST user routes) exactly.
 *
 * This file exercises the FULL real sequence — grant, read via the REAL
 * page-load query (not a re-implementation), simulated outer Save,
 * simulated primary-department reconciliation, Microsoft sync, disabled-role
 * handling — re-reading via ADMIN_USER_LIST_SELECT at every checkpoint,
 * since that is the exact read path the reported bug went through.
 *
 * Usage: npx tsx scripts/test-custom-department-role-persistence.ts
 */
import { prisma } from "@/lib/prisma";
import {
  grantManualMembership,
  setPrimaryDepartmentMembership,
  syncDepartmentMemberships,
  DepartmentRoleAssignmentError,
} from "@/lib/services/department-membership-service";
import { buildAdminUserListQueryArgs } from "@/lib/services/admin-user-list-query";
import { translateGlobalRoleToDepartmentRole } from "@/lib/services/department-role-translation";
import { DepartmentRole, MembershipSource, Role, AuthProvider, RoleScope } from "@prisma/client";

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

/** membershipRoleValue(m) exactly as components/admin/user-department-memberships.tsx implements it — the real display logic under test. */
function membershipRoleValue(m: { role: string; customRoleId: string | null }): string {
  return m.customRoleId ? `custom:${m.customRoleId}` : m.role;
}

/**
 * Reads a user's department memberships through the EXACT real page-load
 * query (the one app/(main)/admin/users/page.tsx runs on every load and
 * every router.refresh()) — never a hand-rolled re-implementation. This is
 * the read path the reported bug went through; any regression here is
 * exactly the bug class this file guards against.
 */
async function readViaRealPageLoadQuery(userId: string, departmentId: string) {
  const args = buildAdminUserListQueryArgs({ departmentId: "all", search: "", page: 1, pageSize: 500 });
  const users = await prisma.user.findMany(args);
  const user = users.find((u) => u.id === userId);
  return user?.departmentMemberships.find((m: any) => m.departmentId === departmentId) as
    | { role: DepartmentRole; customRoleId: string | null; customRole: { id: string; name: string; isActive: boolean } | null; source: MembershipSource; isActive: boolean }
    | undefined;
}

async function main() {
  await prisma.$connect();

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const customRoleIds: string[] = [];

  async function makeUser(email: string, role: Role = Role.USER) {
    const u = await prisma.user.create({ data: { email, role, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(u.id);
    return u;
  }
  async function makeDept(name: string) {
    const d = await prisma.department.create({ data: { name, slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}` } });
    deptIds.push(d.id);
    return d;
  }
  async function makeCustomRole(key: string, name: string, isActive = true) {
    const r = await prisma.customRole.create({ data: { key, name, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive } });
    customRoleIds.push(r.id);
    return r;
  }

  try {
    // ══════════════ 16 (centerpiece). Full real-world sequence: PRIMARY MANUAL Viewer -> custom role ══════════════
    console.log("\n=== 16. Full real-world sequence on a PRIMARY MANUAL membership: Viewer -> custom TEST_ROLE-equivalent ===\n");
    const user16 = await makeUser(`u16-${RUN_ID}@example.com`);
    const dept16 = await makeDept(`Dept16 IT ${RUN_ID}`);
    const custom16 = await makeCustomRole(`SOT_TESTROLE16_${RUN_ID}`, `test role ${RUN_ID}`);

    // Starting state: PRIMARY, built-in VIEWER, source MANUAL (exactly the reported starting point).
    await setPrimaryDepartmentMembership(user16.id, dept16.id, MembershipSource.MANUAL, { role: DepartmentRole.VIEWER });
    let db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("   Fixture: starts VIEWER / customRoleId null / MANUAL / isPrimary true", db.role === "VIEWER" && db.customRoleId === null && db.source === "MANUAL" && db.isPrimary === true);

    // Step: the exact "Select change -> handleChangeRole -> POST" write (grantManualMembership).
    await grantManualMembership(user16.id, dept16.id, { customRoleId: custom16.id });
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("16. DB immediately after the grant: role=VIEWER placeholder, customRoleId=custom role id, source=MANUAL", db.role === "VIEWER" && db.customRoleId === custom16.id && db.source === "MANUAL");
    check("   isPrimary/isActive preserved (true/true)", db.isPrimary === true && db.isActive === true);

    // Step: "close modal without outer Save, full browser reload, reopen" — read via the REAL page-load query.
    let viaPageQuery = await readViaRealPageLoadQuery(user16.id, dept16.id);
    check("16. THE FIX: the real page-load query (ADMIN_USER_LIST_SELECT) returns customRoleId", viaPageQuery?.customRoleId === custom16.id);
    check("   ...and the joined customRole relation (id/name/isActive)", viaPageQuery?.customRole?.id === custom16.id && viaPageQuery?.customRole?.name === custom16.name && viaPageQuery?.customRole?.isActive === true);
    check("16. membershipRoleValue() — the exact dropdown display logic — resolves to custom:<id>, NOT 'VIEWER'", membershipRoleValue(viaPageQuery!) === `custom:${custom16.id}`);

    // Step: outer Edit User Save, department UNCHANGED (the PATCH route's User.update — never touches DepartmentMembership at all when departmentSettingToValue is false).
    await prisma.user.update({ where: { id: user16.id }, data: { email: user16.email } }); // unrelated field, matching what the PATCH route always does
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("16. Custom role survives an outer Save that doesn't touch the primary department", db.customRoleId === custom16.id);
    viaPageQuery = await readViaRealPageLoadQuery(user16.id, dept16.id);
    check("   ...and the real page-load query (post router.refresh()) still shows it", viaPageQuery?.customRoleId === custom16.id);

    // Step: outer Save DOES re-affirm the SAME primary department (setPrimaryDepartmentMembership forced) — protectCustomRole guard.
    const desiredRole16 = translateGlobalRoleToDepartmentRole(Role.USER);
    await setPrimaryDepartmentMembership(user16.id, dept16.id, MembershipSource.MANUAL, { role: desiredRole16 });
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("5. Custom role survives re-saving/re-confirming the SAME Primary Department", db.customRoleId === custom16.id && db.role === "VIEWER");
    viaPageQuery = await readViaRealPageLoadQuery(user16.id, dept16.id);
    check("   ...and is still correctly readable via the real page-load query afterward", membershipRoleValue(viaPageQuery!) === `custom:${custom16.id}`);

    // ══════════════ 6. Survives an unrelated email/account edit ══════════════
    console.log("\n=== 6. Custom role survives an unrelated email/account edit ===\n");
    await prisma.user.update({ where: { id: user16.id }, data: { email: `u16-changed-${RUN_ID}@example.com` } });
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("6. Changing an unrelated field (email) never touches customRoleId", db.customRoleId === custom16.id);

    // ══════════════ 7. Survives Microsoft (per-login) synchronization ══════════════
    console.log("\n=== 7. Custom role survives Microsoft per-login synchronization (secondary-mapping sync) ===\n");
    await syncDepartmentMemberships(user16.id, []); // no secondary mappings resolved this login — must not touch the primary/MANUAL row
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("7. syncDepartmentMemberships never touches the MANUAL primary custom-role row", db.customRoleId === custom16.id);

    // ══════════════ 8. Survives organization directory (full tenant) sync ══════════════
    console.log("\n=== 8. Custom role survives the full organization directory sync's primary-placement call ===\n");
    await setPrimaryDepartmentMembership(user16.id, dept16.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER, deactivateObsoleteMicrosoftPrimary: true });
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    check("8. A full-tenant-sync-style call (source MICROSOFT_DEPARTMENT) never overwrites the existing MANUAL custom role", db.customRoleId === custom16.id && db.source === "MANUAL");

    // ══════════════ 9. Survives first-login reconciliation (same primitives, matching syncMicrosoftUserDepartment's exact sequence) ══════════════
    console.log("\n=== 9. Custom role survives a first-login-style reconciliation (primary placement + secondary mapping sync, in order) ===\n");
    await setPrimaryDepartmentMembership(user16.id, dept16.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER, deactivateObsoleteMicrosoftPrimary: true });
    await syncDepartmentMemberships(user16.id, []);
    db = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user16.id, departmentId: dept16.id } } });
    const finalPageRead = await readViaRealPageLoadQuery(user16.id, dept16.id);
    check("9. After the full reconciliation sequence, DB still shows the custom role", db.customRoleId === custom16.id && db.role === "VIEWER" && db.source === "MANUAL");
    check("   ...AND the real page-load query still resolves the dropdown to 'test role', not 'Viewer'", membershipRoleValue(finalPageRead!) === `custom:${custom16.id}`);

    // ══════════════ 1/2/3/4. Fresh grant, fresh reread, reopen semantics, outer save (isolated, minimal) ══════════════
    console.log("\n=== 1-4. Isolated minimal repro: existing primary VIEWER -> custom, fresh reread, reopen, outer Save ===\n");
    const user1 = await makeUser(`u1-${RUN_ID}@example.com`);
    const dept1 = await makeDept(`Dept1 ${RUN_ID}`);
    const custom1 = await makeCustomRole(`SOT_TESTROLE1_${RUN_ID}`, `custom role 1 ${RUN_ID}`);
    await setPrimaryDepartmentMembership(user1.id, dept1.id, MembershipSource.MANUAL, { role: DepartmentRole.VIEWER });
    await grantManualMembership(user1.id, dept1.id, { customRoleId: custom1.id });
    const row1 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user1.id, departmentId: dept1.id } } });
    check("1. VIEWER/null -> custom: role=VIEWER, customRoleId=custom1.id", row1.role === "VIEWER" && row1.customRoleId === custom1.id);
    check("2. Fresh DB reread confirms customRoleId (separate query, not cached)", (await prisma.departmentMembership.findUniqueOrThrow({ where: { id: row1.id } })).customRoleId === custom1.id);
    const reopen1 = await readViaRealPageLoadQuery(user1.id, dept1.id);
    check("3. Survives closing/reopening semantics (real page-load query)", reopen1?.customRoleId === custom1.id);
    await prisma.user.update({ where: { id: user1.id }, data: { email: user1.email } });
    const afterSave1 = await prisma.departmentMembership.findUniqueOrThrow({ where: { id: row1.id } });
    check("4. Survives outer User Save", afterSave1.customRoleId === custom1.id);

    // ══════════════ 10. custom A -> custom B ══════════════
    console.log("\n=== 10. Change custom A -> custom B persists ===\n");
    const user10 = await makeUser(`u10-${RUN_ID}@example.com`);
    const dept10 = await makeDept(`Dept10 ${RUN_ID}`);
    const customA = await makeCustomRole(`SOT_A_${RUN_ID}`, `Custom A ${RUN_ID}`);
    const customB = await makeCustomRole(`SOT_B_${RUN_ID}`, `Custom B ${RUN_ID}`);
    await grantManualMembership(user10.id, dept10.id, { customRoleId: customA.id });
    await grantManualMembership(user10.id, dept10.id, { customRoleId: customB.id });
    const row10 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user10.id, departmentId: dept10.id } } });
    check("10. customA -> customB persisted", row10.customRoleId === customB.id);

    // ══════════════ 11. custom -> built-in ══════════════
    console.log("\n=== 11. Change custom -> built-in AGENT_ASSIGNEE: customRoleId null, role AGENT_ASSIGNEE ===\n");
    const user11 = await makeUser(`u11c-${RUN_ID}@example.com`);
    const dept11 = await makeDept(`Dept11 ${RUN_ID}`);
    const custom11 = await makeCustomRole(`SOT_C11_${RUN_ID}`, `Custom 11 ${RUN_ID}`);
    await grantManualMembership(user11.id, dept11.id, { customRoleId: custom11.id });
    await grantManualMembership(user11.id, dept11.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    const row11 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user11.id, departmentId: dept11.id } } });
    check("11. customRoleId becomes null, role becomes AGENT_ASSIGNEE", row11.customRoleId === null && row11.role === "AGENT_ASSIGNEE");
    const viaPage11 = await readViaRealPageLoadQuery(user11.id, dept11.id);
    check("   ...and the real page-load query agrees (no stale customRole relation left dangling)", viaPage11?.customRoleId === null && viaPage11?.customRole === null && membershipRoleValue(viaPage11!) === "AGENT_ASSIGNEE");

    // ══════════════ 12. built-in -> custom ══════════════
    console.log("\n=== 12. Change built-in -> custom: role becomes VIEWER placeholder, customRoleId populated ===\n");
    const user12 = await makeUser(`u12c-${RUN_ID}@example.com`);
    const dept12 = await makeDept(`Dept12 ${RUN_ID}`);
    const custom12 = await makeCustomRole(`SOT_C12_${RUN_ID}`, `Custom 12 ${RUN_ID}`);
    await grantManualMembership(user12.id, dept12.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    await grantManualMembership(user12.id, dept12.id, { customRoleId: custom12.id });
    const row12 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user12.id, departmentId: dept12.id } } });
    check("12. role becomes VIEWER placeholder, customRoleId populated", row12.role === "VIEWER" && row12.customRoleId === custom12.id);

    // ══════════════ 13. Disabled custom role cannot be newly selected ══════════════
    console.log("\n=== 13. A disabled custom role cannot be newly selected ===\n");
    const user13 = await makeUser(`u13-${RUN_ID}@example.com`);
    const dept13 = await makeDept(`Dept13 ${RUN_ID}`);
    const disabledRole13 = await makeCustomRole(`SOT_DISABLED13_${RUN_ID}`, `Disabled 13 ${RUN_ID}`, false);
    let rejected13 = false;
    try {
      await grantManualMembership(user13.id, dept13.id, { customRoleId: disabledRole13.id });
    } catch (err) {
      rejected13 = err instanceof DepartmentRoleAssignmentError && err.code === "ROLE_INACTIVE";
    }
    check("13. A NEW assignment to a disabled custom role is rejected (ROLE_INACTIVE)", rejected13);

    // ══════════════ 14. Existing assignment on a subsequently-disabled custom role remains readable ══════════════
    console.log("\n=== 14. Existing assignment on a subsequently-disabled custom role remains readable (both service AND page-load read paths) ===\n");
    const user14 = await makeUser(`u14c-${RUN_ID}@example.com`);
    const dept14 = await makeDept(`Dept14 ${RUN_ID}`);
    const role14 = await makeCustomRole(`SOT_C14_${RUN_ID}`, `Custom 14 ${RUN_ID}`);
    await grantManualMembership(user14.id, dept14.id, { customRoleId: role14.id });
    await prisma.customRole.update({ where: { id: role14.id }, data: { isActive: false } });
    const row14 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user14.id, departmentId: dept14.id } } });
    check("14. Service layer: existing assignment on a now-disabled custom role is still readable", row14.customRoleId === role14.id);
    const viaPage14 = await readViaRealPageLoadQuery(user14.id, dept14.id);
    check("   Page-load query: same — still shows customRoleId, and customRole.isActive correctly reports false", viaPage14?.customRoleId === role14.id && viaPage14?.customRole?.isActive === false);
    // Re-saving unchanged must not throw (the "unchanged is never blocked" rule).
    let unchangedThrew14 = false;
    try {
      await grantManualMembership(user14.id, dept14.id, { customRoleId: role14.id });
    } catch {
      unchangedThrew14 = true;
    }
    check("   Re-saving the SAME (now-disabled) custom role does not throw", !unchangedThrew14);

    // ══════════════ 15. Secondary membership custom role ══════════════
    console.log("\n=== 15. SECONDARY membership custom role behaves correctly ===\n");
    const user15 = await makeUser(`u15-${RUN_ID}@example.com`);
    const deptPrimary15 = await makeDept(`Dept15 Primary ${RUN_ID}`);
    const deptSecondary15 = await makeDept(`Dept15 Secondary ${RUN_ID}`);
    const role15 = await makeCustomRole(`SOT_C15_${RUN_ID}`, `Custom 15 ${RUN_ID}`);
    await setPrimaryDepartmentMembership(user15.id, deptPrimary15.id, MembershipSource.MANUAL, { role: DepartmentRole.REQUESTER });
    await grantManualMembership(user15.id, deptSecondary15.id, { customRoleId: role15.id });
    // Re-affirm the primary department — must never touch the unrelated secondary custom-role membership.
    await setPrimaryDepartmentMembership(user15.id, deptPrimary15.id, MembershipSource.MANUAL, { role: translateGlobalRoleToDepartmentRole(Role.USER) });
    const secondaryRow15 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user15.id, departmentId: deptSecondary15.id } } });
    check("15. Secondary membership's custom role survives a primary-department save", secondaryRow15.customRoleId === role15.id);
    const viaPage15 = await readViaRealPageLoadQuery(user15.id, deptSecondary15.id);
    check("   ...and is correctly readable via the real page-load query too", viaPage15?.customRoleId === role15.id);
  } finally {
    const cleanup: [string, () => Promise<unknown>][] = [
      ["department memberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["custom roles", () => prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
