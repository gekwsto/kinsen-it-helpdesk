/**
 * Regression coverage for turning "All Tickets" and "Closed Tickets" sidebar
 * visibility into real, canonical permission keys instead of hardcoded role
 * checks.
 *
 * BEFORE:
 *   - "All Tickets" was gated by canManageProjects(role) — a hardcoded
 *     ADMIN/IT_AGENT/DEPARTMENT_MANAGER/DIRECTOR enum check, completely
 *     disconnected from what actually determines full-vs-own ticket
 *     visibility (splitTicketViewScope in department-scope-service.ts),
 *     which itself hardcoded `m.role === DepartmentRole.REQUESTER` — since
 *     grantManualMembership ALWAYS stores DepartmentRole.VIEWER as the
 *     required-but-unused placeholder for ANY custom-role membership (see
 *     its own doc comment), every existing custom department role was
 *     silently bucketed as "full view" regardless of what it actually
 *     granted, purely because VIEWER !== REQUESTER.
 *   - "Closed Tickets" was gated by isAdmin(role)/roles:["ADMIN"] — no
 *     permission key existed for it at all, so no custom or built-in
 *     non-ADMIN role could ever be granted it.
 *
 * AFTER: two new canonical permission keys (ticket.view.all,
 * ticket.closed.view — prisma/migrations/20260813150000_...), and
 * splitTicketViewScope now consults ticket.view.all via
 * hasDepartmentPermission (customRoleId-authoritative, same as every other
 * permission check in this codebase) instead of comparing role enum names.
 * NavVisibilityFlags gained canViewAllTickets (= hasAnyFullTicketView,
 * reused, not re-implemented) and canViewClosedTickets (the standard
 * department-OR-global union).
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --import tsx scripts/test-ticket-view-all-and-closed-permissions.ts
 */
import { prisma } from "@/lib/prisma";
import { getNavVisibilityFlags, hasAnyFullTicketView, buildTicketListWhere } from "@/lib/services/department-scope-service";
import { hasDepartmentPermission } from "@/lib/permissions";
import { grantManualMembership, revokeMembership } from "@/lib/services/department-membership-service";
import { Role, DepartmentRole, AuthProvider, RoleScope } from "@prisma/client";

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
  const customRoleKeys: string[] = [];

  async function makeUser(tag: string, role: Role = Role.USER, customRoleId?: string) {
    const u = await prisma.user.create({
      data: { email: `${tag}-${RUN_ID}@example.com`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS },
    });
    userIds.push(u.id);
    return u;
  }
  async function makeDept(tag: string) {
    const d = await prisma.department.create({ data: { name: `${tag} ${RUN_ID}`, slug: `${tag.toLowerCase()}-${RUN_ID}` } });
    deptIds.push(d.id);
    return d;
  }
  async function makeDeptCustomRole(tag: string, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `TVA_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(r.id);
    customRoleKeys.push(r.key);
    for (const key of permissionKeys) {
      const perm = await prisma.permission.findUnique({ where: { key } });
      if (!perm) throw new Error(`Missing canonical permission: ${key}`);
      await prisma.rolePermission.create({ data: { roleKey: r.key, permissionId: perm.id } });
    }
    return r;
  }

  try {
    // ══════════════ 1. DB-level proof: new permissions + default grants ══════════════
    console.log("\n=== 1. New permission keys exist with the intended default grants ===\n");
    const viewAllPerm = await prisma.permission.findUnique({ where: { key: "ticket.view.all" } });
    const closedViewPerm = await prisma.permission.findUnique({ where: { key: "ticket.closed.view" } });
    check("1. ticket.view.all Permission row exists (module=tickets)", viewAllPerm?.module === "tickets");
    check("1. ticket.closed.view Permission row exists (module=tickets)", closedViewPerm?.module === "tickets");

    // Real-DB grants may ALSO include pre-existing custom roles (e.g. from
    // earlier sessions' fixtures like TEST_ROLE, correctly backfilled by
    // the migration) — assert the built-in set is a SUBSET, not an exact
    // match, and assert REQUESTER/PROJECT_MANAGER/USER are absent.
    const viewAllGrants = (await prisma.rolePermission.findMany({ where: { permissionId: viewAllPerm!.id } })).map((r) => r.roleKey);
    const closedViewGrants = (await prisma.rolePermission.findMany({ where: { permissionId: closedViewPerm!.id } })).map((r) => r.roleKey);
    const expectedBuiltInViewAll = ["ADMIN", "AGENT_ASSIGNEE", "DEPARTMENT_ADMIN", "DEPARTMENT_MANAGER", "DIRECTOR", "IT_AGENT", "VIEWER"];
    check("1. ticket.view.all is granted to every expected built-in role (ADMIN/AGENT_ASSIGNEE/DEPARTMENT_ADMIN/DEPARTMENT_MANAGER/DIRECTOR/IT_AGENT/VIEWER)", expectedBuiltInViewAll.every((k) => viewAllGrants.includes(k)));
    check("1. REQUESTER does NOT have ticket.view.all", !viewAllGrants.includes("REQUESTER"));
    check("1. PROJECT_MANAGER/USER do NOT have ticket.view.all (never had ticket.view either)", !viewAllGrants.includes("PROJECT_MANAGER") && !viewAllGrants.includes("USER"));
    check("1. ticket.closed.view default grants = ADMIN only (exact prior isAdmin-only behavior preserved — no built-in non-ADMIN role, and no PRE-EXISTING custom role, was ever silently granted this brand-new key)", JSON.stringify(closedViewGrants.sort()) === JSON.stringify(["ADMIN"]));

    // ══════════════ 2. Built-in REQUESTER stays own-only (the one role deliberately excluded) ══════════════
    console.log("\n=== 2. Built-in REQUESTER: ticket.view=true, ticket.view.all=false => own-only ===\n");
    const dept2 = await makeDept("Requester2");
    const user2 = await makeUser("requester2", Role.USER);
    await grantManualMembership(user2.id, dept2.id, { role: DepartmentRole.REQUESTER });
    check("2. hasDepartmentPermission REQUESTER ticket.view=true", await hasDepartmentPermission(DepartmentRole.REQUESTER, "ticket.view", null));
    check("2. hasDepartmentPermission REQUESTER ticket.view.all=false", !(await hasDepartmentPermission(DepartmentRole.REQUESTER, "ticket.view.all", null)));
    check("2. hasAnyFullTicketView(REQUESTER-only user)=false", !(await hasAnyFullTicketView(user2.id, Role.USER)));

    // ══════════════ 3. Built-in VIEWER/AGENT_ASSIGNEE/DEPARTMENT_ADMIN: full view preserved ══════════════
    console.log("\n=== 3. Built-in VIEWER/AGENT_ASSIGNEE/DEPARTMENT_ADMIN keep full-view (backward compatible) ===\n");
    for (const role of [DepartmentRole.VIEWER, DepartmentRole.AGENT_ASSIGNEE, DepartmentRole.DEPARTMENT_ADMIN, DepartmentRole.DEPARTMENT_MANAGER]) {
      const d = await makeDept(`Builtin3-${role}`);
      const u = await makeUser(`builtin3-${role}`, Role.USER);
      await grantManualMembership(u.id, d.id, { role });
      check(`3. hasAnyFullTicketView(${role}-only user)=true (backward-compatible default)`, await hasAnyFullTicketView(u.id, Role.USER));
    }

    // ══════════════ 4. Custom department role WITHOUT ticket.view.all — the bug this fix closes ══════════════
    console.log("\n=== 4. Custom department role with ticket.view but WITHOUT ticket.view.all => own-only (previously this was ALWAYS full-view, a real bug) ===\n");
    const ownOnlyCustomRole = await makeDeptCustomRole("OWN_ONLY", ["ticket.view"]);
    const dept4 = await makeDept("CustomOwnOnly4");
    const user4 = await makeUser("customownonly4", Role.USER);
    await grantManualMembership(user4.id, dept4.id, { customRoleId: ownOnlyCustomRole.id });
    // Confirm the placeholder invariant this bug hinged on: role is ALWAYS
    // VIEWER (never REQUESTER) for a custom-role membership.
    const membership4 = await prisma.departmentMembership.findUniqueOrThrow({ where: { userId_departmentId: { userId: user4.id, departmentId: dept4.id } } });
    check("4. DepartmentMembership.role placeholder is VIEWER, not REQUESTER, for this custom-role membership (confirms the old role-name check could never have caught this)", membership4.role === DepartmentRole.VIEWER);
    check("4. hasAnyFullTicketView is now correctly FALSE for a custom role granted only ticket.view", !(await hasAnyFullTicketView(user4.id, Role.USER)));

    // ══════════════ 5. Custom department role WITH ticket.view.all — explicit grant works ══════════════
    console.log("\n=== 5. Custom department role explicitly granted ticket.view.all => full-view ===\n");
    const fullViewCustomRole = await makeDeptCustomRole("FULL_VIEW", ["ticket.view", "ticket.view.all"]);
    const dept5 = await makeDept("CustomFullView5");
    const user5 = await makeUser("customfullview5", Role.USER);
    await grantManualMembership(user5.id, dept5.id, { customRoleId: fullViewCustomRole.id });
    check("5. hasAnyFullTicketView=true once ticket.view.all is explicitly granted", await hasAnyFullTicketView(user5.id, Role.USER));

    // ══════════════ 6. NavVisibilityFlags: canViewAllTickets / canViewClosedTickets ══════════════
    console.log("\n=== 6. NavVisibilityFlags.canViewAllTickets / canViewClosedTickets ===\n");
    const flags4 = await getNavVisibilityFlags(user4.id, Role.USER, null);
    check("6. canViewAllTickets=false for the own-only custom-role user (matches hasAnyFullTicketView exactly)", flags4.canViewAllTickets === false);
    const flags5 = await getNavVisibilityFlags(user5.id, Role.USER, null);
    check("6. canViewAllTickets=true for the full-view custom-role user", flags5.canViewAllTickets === true);
    check("6. canViewClosedTickets=false for a plain user with no ticket.closed.view grant", flags5.canViewClosedTickets === false);

    const closedViewCustomRole = await makeDeptCustomRole("CLOSED_VIEW", ["ticket.view", "ticket.closed.view"]);
    const dept6 = await makeDept("ClosedView6");
    const user6 = await makeUser("closedview6", Role.USER);
    await grantManualMembership(user6.id, dept6.id, { customRoleId: closedViewCustomRole.id });
    const flags6 = await getNavVisibilityFlags(user6.id, Role.USER, null);
    check("6. canViewClosedTickets=true once a department custom role grants ticket.closed.view", flags6.canViewClosedTickets === true);

    const globalClosedViewRole = await prisma.customRole.create({ data: { key: `TVA_GLOBAL_CLOSED_${RUN_ID}`, name: `global closed ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true } });
    customRoleIds.push(globalClosedViewRole.id);
    customRoleKeys.push(globalClosedViewRole.key);
    const closedPerm = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.closed.view" } });
    await prisma.rolePermission.create({ data: { roleKey: globalClosedViewRole.key, permissionId: closedPerm.id } });
    const globalClosedUser = await makeUser("globalclosed6", Role.USER, globalClosedViewRole.id);
    const flags6b = await getNavVisibilityFlags(globalClosedUser.id, Role.USER, globalClosedViewRole.id);
    check("6. canViewClosedTickets=true via a GLOBAL custom role grant too (department-OR-global union, same shape as every other canView* flag)", flags6b.canViewClosedTickets === true);

    // ══════════════ 7. ADMIN/DIRECTOR bypass unchanged ══════════════
    console.log("\n=== 7. ADMIN bypass unconditional ===\n");
    const adminFlags = await getNavVisibilityFlags("unused-admin-id", Role.ADMIN, null);
    check("7. ADMIN: canViewAllTickets=true, canViewClosedTickets=true unconditionally", adminFlags.canViewAllTickets && adminFlags.canViewClosedTickets);

    // ══════════════ 8. Data-scoping proof: buildTicketListWhere really differs for own-only vs full-view ══════════════
    console.log("\n=== 8. buildTicketListWhere: own-only user's scope excludes other users' tickets; full-view user's scope includes the whole department ===\n");
    const scopeOwnOnly = await buildTicketListWhere(user4.id, Role.USER, dept4.id);
    const scopeFullView = await buildTicketListWhere(user5.id, Role.USER, dept5.id);
    check("8. own-only user's scope is NOT a bare {departmentId} filter (it's requester/share-conditioned)", !("denied" in scopeOwnOnly) && JSON.stringify(scopeOwnOnly) !== JSON.stringify({ departmentId: dept4.id }));
    check("8. full-view user's scope IS a bare {departmentId} filter (sees every ticket in the department)", !("denied" in scopeFullView) && JSON.stringify(scopeFullView) === JSON.stringify({ departmentId: dept5.id }));

    // ══════════════ 9. Source-text agreement: sidebar/page no longer use canManageProjects/isAdmin for these two ══════════════
    console.log("\n=== 9. Sidebar + Closed Tickets page source-text proof ===\n");
    const fs = await import("fs");
    const sidebarSrc = fs.readFileSync("components/layout/sidebar.tsx", "utf-8");
    const closedPageSrc = fs.readFileSync("app/(main)/tickets/closed/page.tsx", "utf-8");
    check("9. Sidebar's All Tickets uses navFlags.canViewAllTickets", sidebarSrc.includes('href: "/tickets", visible: navFlags.canViewAllTickets'));
    check("9. Sidebar's Closed Tickets uses navFlags.canViewClosedTickets", sidebarSrc.includes('href: "/tickets/closed", visible: navFlags.canViewClosedTickets'));
    check("9. Sidebar no longer imports canManageProjects/isAdmin from nav-access (both fully replaced by permission-driven flags)", !sidebarSrc.includes('from "@/lib/nav-access"'));
    check("9. app/(main)/tickets/closed/page.tsx no longer gates on isAdmin(...)", !closedPageSrc.includes("isAdmin(session.user.role)") && closedPageSrc.includes("canViewClosedTickets"));
  } finally {
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
