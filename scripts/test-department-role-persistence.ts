/**
 * Regression coverage for the "Department Role change from User Management
 * does not appear to persist" production bug.
 *
 * ROOT CAUSE (proved by direct reproduction against this real dev database,
 * not just code inspection — see the session's audit): the admin Edit User
 * dialog's OUTER "Save" button always re-sends the user's Primary
 * Department, even when the admin never touched that field. The PATCH
 * route only calls setPrimaryDepartmentMembership() when the submitted
 * department id actually differs from the user's CURRENT
 * User.departmentId — so for the single most literal repro ("open the
 * dialog, change one department's role, click Save") that call never even
 * fires, and the change is safe. The REAL trigger is any sequence where
 * setPrimaryDepartmentMembership() DOES run against a department that
 * already has an active, source:MANUAL DepartmentMembership row with a
 * deliberately-chosen role — the most common being "grant a department
 * membership with a specific role, then also mark that department as the
 * user's Primary Department in the same Edit User session" (a completely
 * natural admin workflow). setPrimaryDepartmentMembership's OLD protection
 * only shielded a MANUAL row's role from a NON-manual caller (i.e. Microsoft
 * sync) — an admin-driven MANUAL call (source: MANUAL) setting the primary
 * department did NOT count as "non-manual", so it fell through to the
 * "role genuinely differs -> overwrite" branch and silently replaced the
 * admin's just-chosen department role with translateGlobalRoleToDepartmentRole(user's
 * GLOBAL role) — e.g. AGENT_ASSIGNEE silently became REQUESTER for a
 * Role.USER user.
 *
 * FIX (lib/services/department-membership-service.ts,
 * setPrimaryDepartmentMembership): a target row already sourced MANUAL
 * has its role/customRoleId protected unconditionally now — regardless of
 * the CALLER's own source. Setting "this department is primary" and
 * setting "this is the role in this department" are two independent admin
 * decisions; neither may silently overwrite the other. Microsoft sync's
 * ability to self-correct its OWN non-manual rows is unaffected (verified
 * below) — this only changes behavior when the EXISTING row was already
 * MANUAL.
 *
 * Frontend audit finding (Check A in the investigation): the Edit User
 * dialog's `onChange` handler for UserDepartmentMemberships ALREADY
 * updates both `editMemberships` (the open dialog's own state) AND the
 * parent `users` array (`setUsers`) on every successful membership
 * mutation — re-opening the dialog for the same user (openEdit reads from
 * the `users` array) already reflects the fresh membership. No frontend
 * fix was needed there; this file proves the underlying data layer is
 * correct so that binding holds.
 *
 * Usage: npx tsx scripts/test-department-role-persistence.ts
 */
import { prisma } from "@/lib/prisma";
import {
  grantManualMembership,
  setPrimaryDepartmentMembership,
  getDepartmentMemberships,
  syncDepartmentMemberships,
} from "@/lib/services/department-membership-service";
import { translateGlobalRoleToDepartmentRole } from "@/lib/services/department-role-translation";
import { hasDepartmentPermission } from "@/lib/permissions";
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

  try {
    // ══════════════════════ 7. Built-in Department Role change persists ══════════════════════
    console.log("\n=== 7. Built-in Department Role change persists (real Prisma write + fresh reread) ===\n");
    const u7 = await makeUser(`u7-${RUN_ID}@example.com`);
    const d7 = await makeDept(`Dept7 ${RUN_ID}`);
    await grantManualMembership(u7.id, d7.id, { role: DepartmentRole.REQUESTER });
    await grantManualMembership(u7.id, d7.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    const row7 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u7.id, departmentId: d7.id } } });
    check("7. Role change from REQUESTER to AGENT_ASSIGNEE persisted", row7.role === DepartmentRole.AGENT_ASSIGNEE);
    check("   customRoleId is null for a built-in role", row7.customRoleId === null);
    check("   source is MANUAL", row7.source === MembershipSource.MANUAL);

    // ══════════════════════ 8. Custom Department Role change persists ══════════════════════
    console.log("\n=== 8. Custom Department Role change persists ===\n");
    const customRole8 = await prisma.customRole.create({
      data: { key: `SOT_PERSIST_${RUN_ID}`, name: `Persist Test Role ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(customRole8.id);
    const u8 = await makeUser(`u8-${RUN_ID}@example.com`);
    const d8 = await makeDept(`Dept8 ${RUN_ID}`);
    await grantManualMembership(u8.id, d8.id, { role: DepartmentRole.REQUESTER });
    await grantManualMembership(u8.id, d8.id, { customRoleId: customRole8.id });
    const row8 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u8.id, departmentId: d8.id } } });
    check("8. customRoleId persisted to the custom role", row8.customRoleId === customRole8.id);
    check("   role column holds the required VIEWER placeholder", row8.role === DepartmentRole.VIEWER);
    check("   source is MANUAL", row8.source === MembershipSource.MANUAL);

    // ══════════════════════ 9. Visible after fresh DB reread, not just React state ══════════════════════
    console.log("\n=== 9. Change is visible via a completely fresh query (getDepartmentMemberships — what GET .../members returns) ===\n");
    const freshList = await getDepartmentMemberships(d7.id);
    const freshRow = freshList.find((m) => m.userId === u7.id);
    check("9. A brand-new getDepartmentMemberships() call (not any cached/in-memory value) reflects the change", freshRow?.role === DepartmentRole.AGENT_ASSIGNEE);

    // ══════════════════════ 10. Survives "modal reload" semantics ══════════════════════
    console.log("\n=== 10. Survives page/modal reload semantics (re-fetching the user's full include, as openEdit would) ===\n");
    const reread = await prisma.user.findUniqueOrThrow({
      where: { id: u7.id },
      include: { departmentMemberships: { include: { customRole: true } } },
    });
    const rereadMembership = reread.departmentMemberships.find((m) => m.departmentId === d7.id);
    check("10. Re-fetching the user fresh (simulating a modal close+reopen or a page reload) shows the persisted role", rereadMembership?.role === DepartmentRole.AGENT_ASSIGNEE);

    // ══════════════════════ 11/13. Survives outer Edit User Save — PRIMARY membership (the fixed bug) ══════════════════════
    console.log("\n=== 11/13. PRIMARY membership: Department Role survives the outer Edit User Save (the exact bug that was fixed) ===\n");
    const u11 = await makeUser(`u11-${RUN_ID}@example.com`);
    const d11 = await makeDept(`Dept11 Finance ${RUN_ID}`);
    // Grant a deliberately-chosen role, then mark the SAME department as
    // primary in the same session — the exact real-world trigger.
    await grantManualMembership(u11.id, d11.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    const desiredRole11 = translateGlobalRoleToDepartmentRole(Role.USER);
    check("   Sanity: the translated default (REQUESTER) genuinely differs from the chosen role (AGENT_ASSIGNEE) — otherwise this test wouldn't be able to detect the bug", desiredRole11 !== DepartmentRole.AGENT_ASSIGNEE);
    await setPrimaryDepartmentMembership(u11.id, d11.id, MembershipSource.MANUAL, { role: desiredRole11 });
    const row11 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u11.id, departmentId: d11.id } } });
    check("11. The deliberately-chosen role (AGENT_ASSIGNEE) is NOT overwritten by setting the same department as primary", row11.role === DepartmentRole.AGENT_ASSIGNEE);
    check("13. Primary membership: role persists, isPrimary is true, source stays MANUAL", row11.isPrimary === true && row11.source === MembershipSource.MANUAL);

    // Same scenario again, but simulating an admin editing a user who ALREADY has this as primary (repeat save) — must still be a no-op on role.
    await setPrimaryDepartmentMembership(u11.id, d11.id, MembershipSource.MANUAL, { role: desiredRole11 });
    const row11b = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u11.id, departmentId: d11.id } } });
    check("   Repeating the outer Save again still does not touch the manually-chosen role", row11b.role === DepartmentRole.AGENT_ASSIGNEE);

    // Custom role on the primary membership must also survive.
    const customRole11 = await prisma.customRole.create({
      data: { key: `SOT_PRIMARY_CUSTOM_${RUN_ID}`, name: `Primary Custom Role ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(customRole11.id);
    await grantManualMembership(u11.id, d11.id, { customRoleId: customRole11.id });
    await setPrimaryDepartmentMembership(u11.id, d11.id, MembershipSource.MANUAL, { role: desiredRole11 });
    const row11c = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u11.id, departmentId: d11.id } } });
    check("   A custom role on the primary membership also survives the outer Save (protectCustomRole)", row11c.customRoleId === customRole11.id);

    // ══════════════════════ 14. SECONDARY membership role survives outer Save ══════════════════════
    console.log("\n=== 14. SECONDARY membership: Department Role survives the outer Edit User Save ===\n");
    const u14 = await makeUser(`u14-${RUN_ID}@example.com`);
    const dPrimary14 = await makeDept(`Dept14 Primary ${RUN_ID}`);
    const dSecondary14 = await makeDept(`Dept14 Secondary ${RUN_ID}`);
    await setPrimaryDepartmentMembership(u14.id, dPrimary14.id, MembershipSource.MANUAL, { role: DepartmentRole.REQUESTER });
    await grantManualMembership(u14.id, dSecondary14.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    // Outer Save re-affirms the SAME primary department (dPrimary14) — must never touch the unrelated secondary membership.
    await setPrimaryDepartmentMembership(u14.id, dPrimary14.id, MembershipSource.MANUAL, { role: translateGlobalRoleToDepartmentRole(Role.USER) });
    const secondaryRow = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u14.id, departmentId: dSecondary14.id } } });
    check("14. The secondary membership's role is completely untouched by a primary-department save", secondaryRow.role === DepartmentRole.AGENT_ASSIGNEE && secondaryRow.source === MembershipSource.MANUAL);

    // ══════════════════════ 12. MANUAL role survives Microsoft synchronization ══════════════════════
    console.log("\n=== 12. MANUAL role survives Microsoft synchronization (secondary + primary reconciliation) ===\n");
    // Secondary path: syncDepartmentMemberships (used by both per-login sync and full org sync).
    const u12 = await makeUser(`u12-${RUN_ID}@example.com`);
    const d12 = await makeDept(`Dept12 ${RUN_ID}`);
    await grantManualMembership(u12.id, d12.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    await syncDepartmentMemberships(u12.id, [{ departmentId: d12.id, role: DepartmentRole.VIEWER, customRoleId: null, source: MembershipSource.MICROSOFT_GROUP }]);
    const row12 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u12.id, departmentId: d12.id } } });
    check("12. syncDepartmentMemberships never overwrites a MANUAL secondary row, even with a conflicting Microsoft signal", row12.role === DepartmentRole.AGENT_ASSIGNEE && row12.source === MembershipSource.MANUAL);

    // Primary path: setPrimaryDepartmentMembership called BY Microsoft sync (source MICROSOFT_DEPARTMENT) against an existing MANUAL primary.
    const u12p = await makeUser(`u12p-${RUN_ID}@example.com`);
    const d12p = await makeDept(`Dept12p ${RUN_ID}`);
    await setPrimaryDepartmentMembership(u12p.id, d12p.id, MembershipSource.MANUAL, { role: DepartmentRole.AGENT_ASSIGNEE });
    await setPrimaryDepartmentMembership(u12p.id, d12p.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER, deactivateObsoleteMicrosoftPrimary: true });
    const row12p = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u12p.id, departmentId: d12p.id } } });
    check("12. setPrimaryDepartmentMembership never overwrites a MANUAL primary role via a Microsoft sync call either", row12p.role === DepartmentRole.AGENT_ASSIGNEE && row12p.source === MembershipSource.MANUAL);

    // Microsoft sync must still be able to self-correct its OWN non-manual rows (regression guard — the fix must not be over-broad).
    const u12s = await makeUser(`u12s-${RUN_ID}@example.com`);
    const d12s = await makeDept(`Dept12s ${RUN_ID}`);
    await setPrimaryDepartmentMembership(u12s.id, d12s.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
    await setPrimaryDepartmentMembership(u12s.id, d12s.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.AGENT_ASSIGNEE });
    const row12s = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u12s.id, departmentId: d12s.id } } });
    check("   Regression guard: Microsoft sync can still self-correct its OWN non-manual primary role (fix is not over-broad)", row12s.role === DepartmentRole.AGENT_ASSIGNEE && row12s.source === MembershipSource.MICROSOFT_DEPARTMENT);

    // End-to-end 5-step reproduction exactly as specified: existing
    // Microsoft-linked user -> manual role change -> source becomes MANUAL
    // -> re-run reconciliation -> manual role unchanged.
    console.log("\n=== 12 (end-to-end 5-step). Existing Microsoft-linked user: manual change survives a full reconciliation re-run ===\n");
    const u12e = await makeUser(`u12e-${RUN_ID}@example.com`);
    const d12e = await makeDept(`Dept12e ${RUN_ID}`);
    // Step 1: existing Microsoft-linked user, organically placed by sync.
    await setPrimaryDepartmentMembership(u12e.id, d12e.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER });
    let step = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u12e.id, departmentId: d12e.id } } });
    check("   Step 1: organically placed, source MICROSOFT_DEPARTMENT", step.source === MembershipSource.MICROSOFT_DEPARTMENT);
    // Step 2/3: admin manually changes the role -> source becomes MANUAL.
    await grantManualMembership(u12e.id, d12e.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    step = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u12e.id, departmentId: d12e.id } } });
    check("   Step 2/3: role AGENT_ASSIGNEE, source now MANUAL", step.role === DepartmentRole.AGENT_ASSIGNEE && step.source === MembershipSource.MANUAL);
    // Step 4: re-run the corresponding sync/reconciliation (both the primary-placement call AND the secondary-mapping sync a real login would trigger).
    await setPrimaryDepartmentMembership(u12e.id, d12e.id, MembershipSource.MICROSOFT_DEPARTMENT, { role: DepartmentRole.REQUESTER, deactivateObsoleteMicrosoftPrimary: true });
    await syncDepartmentMemberships(u12e.id, []);
    // Step 5: manual role remains exactly the same.
    step = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: u12e.id, departmentId: d12e.id } } });
    check("   Step 5: manual role (AGENT_ASSIGNEE) remains exactly the same after reconciliation re-runs", step.role === DepartmentRole.AGENT_ASSIGNEE && step.source === MembershipSource.MANUAL);

    // ══════════════════════ 15/16. Authorization ══════════════════════
    console.log("\n=== 15/16. Authorization: department.user.assign gates the membership-change endpoint correctly ===\n");
    const deptAdminHas = await hasDepartmentPermission(DepartmentRole.DEPARTMENT_ADMIN, "department.user.assign", null);
    check("16. DEPARTMENT_ADMIN (a real department-scoped role, not System Admin) HAS department.user.assign", deptAdminHas === true);
    const deptManagerHas = await hasDepartmentPermission(DepartmentRole.DEPARTMENT_MANAGER, "department.user.assign", null);
    check("16. DEPARTMENT_MANAGER also has department.user.assign (matches ROLE_PERMISSIONS)", deptManagerHas === true);
    const requesterHas = await hasDepartmentPermission(DepartmentRole.REQUESTER, "department.user.assign", null);
    check("15. REQUESTER (an ordinary department role) does NOT have department.user.assign -> would be correctly rejected with 403", requesterHas === false);
    const viewerHas = await hasDepartmentPermission(DepartmentRole.VIEWER, "department.user.assign", null);
    check("15. VIEWER does NOT have department.user.assign either", viewerHas === false);
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
