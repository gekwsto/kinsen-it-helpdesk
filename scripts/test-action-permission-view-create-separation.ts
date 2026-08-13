/**
 * Regression coverage for the "VIEW implies CREATE" privilege-escalation
 * bug that appeared immediately after the previous sidebar/effective-
 * permission fix (see scripts/test-sidebar-effective-permission-visibility.ts).
 *
 * REAL REPORTED SCENARIO: a user with a global custom role granting only
 * project.view (not project.create) and a department custom role granting
 * only ticket.view + activity.view (not ticket.create/activity.create)
 * could see "New Project" and "New Activity" in the sidebar and open
 * app/(main)/activities/new — because:
 *
 *   1. components/layout/sidebar.tsx's "New Project"/"New Activity" child
 *      links had NO `visible` gate of their own at all — they only
 *      inherited the parent's visibility, which the PREVIOUS fix correctly
 *      changed from a hardcoded role check to a *.view-based union. Once
 *      the parent started correctly returning true for a view-only custom
 *      role, these ungated children became reachable too.
 *   2. app/(main)/projects/page.tsx rendered its own "New Project" button
 *      completely unconditionally (no permission check at all).
 *   3. app/(main)/activities/new/page.tsx had ZERO activity.create check —
 *      any authenticated user could open the create form.
 *   4. Several page-level *.create gates (app/(main)/projects/new,
 *      app/(main)/tickets/new, the in-page "New Ticket"/"New Activity"
 *      buttons on the list pages) called hasPermission(role, key,
 *      customRoleId) directly — GLOBAL-only, blind to department-scoped
 *      *.create grants (the same bug class already fixed for *.view in the
 *      prior session, just not yet applied to *.create).
 *
 * SECURITY VERDICT (proven below, not assumed): POST /api/activities and
 * POST /api/projects were ALREADY correctly gated server-side via
 * resolveDepartmentForCreate(..., "activity.create"/"project.create") —
 * this was a UI-only bug for those two modules (a view-only user could see
 * the form and submit it, but the mutation itself would already 403). A
 * SEPARATE, real over-restriction bug was found in POST /api/tickets (a
 * redundant GLOBAL-only hasPermission pre-check that wrongly 403'd
 * legitimate department-scoped ticket.create grants before ever reaching
 * the correct resolveDepartmentForCreate check) — removed.
 *
 * FIX: lib/services/department-scope-service.ts's NavVisibilityFlags gained
 * canCreateTickets/canCreateProjects/canCreateActivities/canCreateGoals,
 * each independently computed from the module's OWN *.create permission key
 * via the same department-scoped-OR-global union already used for the
 * *.view flags — never derived from the matching *.view flag. Every
 * consumer (Sidebar, the create pages, the list pages' "New X" buttons, the
 * API routes) now sources CREATE from these flags / the canonical
 * resolveDepartmentForCreate, never from *.view or a role-name shortcut.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-action-permission-view-create-separation.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
  // Dynamically imported here, AFTER mock.module() above has registered —
  // a top-level static import of any module that transitively imports
  // @/lib/auth (lib/permissions.ts, lib/services/department-membership-
  // service.ts) would resolve and cache the REAL auth() before the mock
  // ever takes effect, since static imports are hoisted ahead of all
  // top-level code including the mock.module() call itself. Confirmed by
  // reproducing the exact failure first: a static top-level import of these
  // made requireAuth() call the real next-auth auth(), which threw
  // "headers was called outside a request scope" instead of returning the
  // mocked session.
  const { getNavVisibilityFlags } = await import("@/lib/services/department-scope-service");
  const { hasPermission, hasDepartmentPermission } = await import("@/lib/permissions");
  const { grantManualMembership } = await import("@/lib/services/department-membership-service");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const userIds: string[] = [];
  const deptIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const ticketIds: string[] = [];
  const ticketStatusIds: string[] = [];

  async function makeUser(tag: string, role: Role = Role.USER, customRoleId?: string) {
    const u = await prisma.user.create({
      data: { email: `${tag}-${RUN_ID}@example.com`, role, customRoleId, authProvider: AuthProvider.CREDENTIALS },
    });
    userIds.push(u.id);
    return u;
  }
  async function makeDept(tag: string) {
    // createDepartment() (not a raw prisma.department.create) — it
    // atomically provisions the starter config rows (ActivityProgressConfig,
    // terminal-status, priority-order, SLA priorities) real Activity/Project
    // creation requires; a hand-rolled department row is missing these and
    // the create APIs correctly reject writes into a mis-configured
    // department (a real, unrelated data-integrity guard, not part of this
    // bug — see lib/services/config-starter-data.ts).
    const d = await createDepartment({ name: `${tag} ${RUN_ID}`, slug: `${tag.toLowerCase()}-${RUN_ID}` });
    deptIds.push(d.id);
    return d;
  }
  async function makeCustomRole(tag: string, scope: RoleScope, permissionKeys: string[]) {
    const r = await prisma.customRole.create({
      data: { key: `ACTVC_${tag}_${RUN_ID}`, name: `${tag} ${RUN_ID}`, isBuiltIn: false, scope, isActive: true },
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
    // ══════════════ 1/2. DB-level proof + effective-permission baseline (real reported combination) ══════════════
    console.log("\n=== 1-2. Exact reported combination: global custom role (project.view only) + department custom role (ticket.view+activity.view only) ===\n");
    const dept = await makeDept("ActionPermDept");
    const globalRole = await makeCustomRole("GLOBAL_PROJECT_VIEW_ONLY", RoleScope.GLOBAL, ["project.view"]);
    const deptRole = await makeCustomRole("DEPT_TICKET_ACTIVITY_VIEW_ONLY", RoleScope.DEPARTMENT, ["ticket.view", "activity.view"]);
    const user = await makeUser("core", Role.USER, globalRole.id);
    await grantManualMembership(user.id, dept.id, { customRoleId: deptRole.id });

    const globalPerms = (await prisma.rolePermission.findMany({ where: { roleKey: globalRole.key }, include: { permission: true } })).map((p) => p.permission.key);
    const deptPerms = (await prisma.rolePermission.findMany({ where: { roleKey: deptRole.key }, include: { permission: true } })).map((p) => p.permission.key);
    check("1. Global custom role RolePermission rows contain project.view", globalPerms.includes("project.view"));
    check("1. Global custom role RolePermission rows do NOT contain project.create (direct DB read)", !globalPerms.includes("project.create"));
    check("1. Department custom role RolePermission rows contain ticket.view + activity.view", deptPerms.includes("ticket.view") && deptPerms.includes("activity.view"));
    check("1. Department custom role RolePermission rows do NOT contain ticket.create or activity.create (direct DB read)", !deptPerms.includes("ticket.create") && !deptPerms.includes("activity.create"));

    check("2. hasPermission: project.view=true (global)", await hasPermission(Role.USER, "project.view", globalRole.id));
    check("2. hasPermission: project.create=false (global)", !(await hasPermission(Role.USER, "project.create", globalRole.id)));
    check("2. hasDepartmentPermission: ticket.view=true, activity.view=true (department)", (await hasDepartmentPermission(DepartmentRole.VIEWER, "ticket.view", deptRole.id)) && (await hasDepartmentPermission(DepartmentRole.VIEWER, "activity.view", deptRole.id)));
    check("2. hasDepartmentPermission: ticket.create=false, activity.create=false (department)", !(await hasDepartmentPermission(DepartmentRole.VIEWER, "ticket.create", deptRole.id)) && !(await hasDepartmentPermission(DepartmentRole.VIEWER, "activity.create", deptRole.id)));

    // ══════════════ Baseline navFlags ══════════════
    let flags = await getNavVisibilityFlags(user.id, Role.USER, globalRole.id);
    check("Baseline: canViewTickets=true, canViewActivities=true, canViewProjects=true", flags.canViewTickets && flags.canViewActivities && flags.canViewProjects);
    check("Baseline: canCreateTickets=false, canCreateActivities=false, canCreateProjects=false (VIEW does not imply CREATE)", !flags.canCreateTickets && !flags.canCreateActivities && !flags.canCreateProjects);

    // ══════════════ Section 6 — direct API POST tests (real route handlers, mocked session) ══════════════
    console.log("\n=== 6/13. Direct handcrafted POST with only *.view — must 403, zero rows created ===\n");
    const { POST: activitiesPOST } = await import("@/app/api/activities/route");
    const { POST: projectsPOST } = await import("@/app/api/projects/route");
    const { POST: ticketsPOST } = await import("@/app/api/tickets/route");

    const jsonReq = (url: string, body: unknown) =>
      new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    currentSession = { user: { id: user.id, role: Role.USER, customRoleId: globalRole.id } };

    const activityCountBefore = await prisma.projectActivity.count({ where: { departmentId: dept.id } });
    const activityRes = await activitiesPOST(jsonReq("http://localhost/api/activities", { title: `Should never exist ${RUN_ID}`, departmentId: dept.id }));
    check("13.2/13.3 POST /api/activities with only activity.view -> 403", activityRes.status === 403);
    const activityCountAfterDenied = await prisma.projectActivity.count({ where: { departmentId: dept.id } });
    check("13.3 Zero Activity rows created after the denied POST", activityCountAfterDenied === activityCountBefore);

    const projectCountBefore = await prisma.project.count({ where: { departmentId: dept.id } });
    const projectRes = await projectsPOST(jsonReq("http://localhost/api/projects", { title: `Should never exist ${RUN_ID}`, departmentId: dept.id }));
    check("13.8/13.9 POST /api/projects with only project.view -> 403", projectRes.status === 403);
    const projectCountAfterDenied = await prisma.project.count({ where: { departmentId: dept.id } });
    check("13.9 Zero Project rows created after the denied POST", projectCountAfterDenied === projectCountBefore);

    const ticketCountBefore = await prisma.ticket.count({ where: { departmentId: dept.id } });
    const ticketRes = await ticketsPOST(jsonReq("http://localhost/api/tickets", { title: `Should never exist ${RUN_ID}`, description: "This should never be created, ever.", departmentId: dept.id }));
    check("13.11/13.12 POST /api/tickets with only ticket.view -> 403", ticketRes.status === 403);
    const ticketCountAfterDenied = await prisma.ticket.count({ where: { departmentId: dept.id } });
    check("13.12 Zero Ticket rows created after the denied POST", ticketCountAfterDenied === ticketCountBefore);

    // ══════════════ Section 5 — direct URL access to create pages (server component gate, invoked directly) ══════════════
    console.log("\n=== 5. Direct navigation to create pages with only *.view — server-side gate must deny ===\n");
    const activitiesNewFlags = await getNavVisibilityFlags(user.id, Role.USER, globalRole.id);
    check("5. app/(main)/activities/new's own gate (canCreateActivities) is false for this view-only user — page redirects", !activitiesNewFlags.canCreateActivities);
    check("5. app/(main)/projects/new's own gate (canCreateProjects) is false for this view-only user — page redirects", !activitiesNewFlags.canCreateProjects);
    check("5. app/(main)/tickets/new's own gate (canCreateTickets) is false for this view-only user — page redirects", !activitiesNewFlags.canCreateTickets);

    // ══════════════ 14. Then add activity.create — independence proof ══════════════
    console.log("\n=== 14. Grant activity.create on the DEPARTMENT role only — must activate Activities create ONLY ===\n");
    const activityCreatePerm = await prisma.permission.findUnique({ where: { key: "activity.create" } });
    await prisma.rolePermission.create({ data: { roleKey: deptRole.key, permissionId: activityCreatePerm!.id } });

    flags = await getNavVisibilityFlags(user.id, Role.USER, globalRole.id);
    check("14. canCreateActivities=true after granting activity.create", flags.canCreateActivities === true);
    check("14. canCreateProjects STILL false (module independence — activity grant doesn't leak into projects)", flags.canCreateProjects === false);
    check("14. canCreateTickets STILL false (module independence)", flags.canCreateTickets === false);

    const activityRes2 = await activitiesPOST(jsonReq("http://localhost/api/activities", { title: `Real activity ${RUN_ID}`, departmentId: dept.id }));
    check("14. POST /api/activities now succeeds (201) once activity.create is granted", activityRes2.status === 201);
    if (activityRes2.status === 201) {
      const created = await activityRes2.json();
      activityIds.push(created.id);
    }
    const projectResStill = await projectsPOST(jsonReq("http://localhost/api/projects", { title: `Should still never exist ${RUN_ID}`, departmentId: dept.id }));
    check("14. POST /api/projects still 403 (project.create still not granted)", projectResStill.status === 403);

    // ══════════════ Then add project.create ══════════════
    // Granted on the DEPARTMENT role, not the global one — a real,
    // pre-existing (not introduced by this fix) architectural nuance:
    // resolveDepartmentForCreate (the sole POST-time authority) resolves
    // creation entirely from the caller's DepartmentMembership grant (or
    // the ADMIN/DIRECTOR canViewAllDepartments bypass) — it has NO global-
    // grant fallback, because creating an entity always requires picking a
    // specific department, and a bare global grant with zero department
    // membership doesn't answer "which one." The SAME asymmetry already
    // existed pre-fix for buildProjectListWhere/buildActivityListWhere
    // (Task 6's own audit). This means navFlags.canCreateProjects can be
    // true purely from a global grant while POST /api/projects would still
    // 403 until that SAME department also grants it — a known, documented,
    // pre-existing limitation (see the final report's "remaining risks"),
    // not a regression this fix introduces.
    console.log("\n=== Then grant project.create on the DEPARTMENT role — Projects activates independently ===\n");
    const projectCreatePerm = await prisma.permission.findUnique({ where: { key: "project.create" } });
    await prisma.rolePermission.create({ data: { roleKey: deptRole.key, permissionId: projectCreatePerm!.id } });
    flags = await getNavVisibilityFlags(user.id, Role.USER, globalRole.id);
    check("canCreateProjects=true after granting project.create (department)", flags.canCreateProjects === true);
    const projectRes2 = await projectsPOST(jsonReq("http://localhost/api/projects", { title: `Real project ${RUN_ID}`, departmentId: dept.id }));
    check("POST /api/projects now succeeds (201) once project.create is granted at the department level", projectRes2.status === 201);
    if (projectRes2.status === 201) {
      const created = await projectRes2.json();
      projectIds.push(created.id);
    }

    // ══════════════ 15. Built-in role regression ══════════════
    console.log("\n=== 15. Built-in global/department role regression ===\n");
    const itAgentFlags = await getNavVisibilityFlags("unused-id-builtin", Role.IT_AGENT, null);
    check("15. Built-in global IT_AGENT: canViewTickets/Projects/Activities=true, canCreateTickets/Projects/Activities=true (IT_AGENT genuinely has all *.create keys per seed.ts)", itAgentFlags.canViewTickets && itAgentFlags.canViewProjects && itAgentFlags.canViewActivities && itAgentFlags.canCreateTickets && itAgentFlags.canCreateProjects && itAgentFlags.canCreateActivities);

    const viewerDept = await makeDept("BuiltinViewerDept15");
    const viewerUser = await makeUser("builtinviewer15", Role.USER);
    await grantManualMembership(viewerUser.id, viewerDept.id, { role: DepartmentRole.VIEWER });
    const viewerFlags = await getNavVisibilityFlags(viewerUser.id, Role.USER, null);
    check("15. Built-in department VIEWER: canViewProjects=true (VIEWER grants project.view)", viewerFlags.canViewProjects === true);
    check("15. Built-in department VIEWER: canCreateProjects=false (VIEWER grants NO create keys — built-in roles are not exempt from VIEW != CREATE)", viewerFlags.canCreateProjects === false);

    const agentDept = await makeDept("BuiltinAgentDept15");
    const agentUser = await makeUser("builtinagent15", Role.USER);
    await grantManualMembership(agentUser.id, agentDept.id, { role: DepartmentRole.AGENT_ASSIGNEE });
    const agentFlags = await getNavVisibilityFlags(agentUser.id, Role.USER, null);
    check("15. Built-in department AGENT_ASSIGNEE: canCreateTickets=true (AGENT_ASSIGNEE genuinely has ticket.create per seed.ts)", agentFlags.canCreateTickets === true);
    check("15. Built-in department AGENT_ASSIGNEE: canCreateProjects=false (AGENT_ASSIGNEE has project.view but NOT project.create — same module-independence rule applies to built-in roles)", agentFlags.canCreateProjects === false);
    check("15. Built-in department AGENT_ASSIGNEE: canCreateActivities=false (AGENT_ASSIGNEE has activity.edit/assignable but NOT activity.create)", agentFlags.canCreateActivities === false);

    // ══════════════ 19/20. ADMIN unchanged; backend/page/UI agreement ══════════════
    console.log("\n=== 19-20. ADMIN unchanged; source-text agreement proof ===\n");
    const adminFlags = await getNavVisibilityFlags("unused-admin-id", Role.ADMIN, null);
    check("19. ADMIN: every canView*/canCreate* flag is true unconditionally", adminFlags.canViewTickets && adminFlags.canViewProjects && adminFlags.canViewActivities && adminFlags.canViewGoals && adminFlags.canCreateTickets && adminFlags.canCreateProjects && adminFlags.canCreateActivities && adminFlags.canCreateGoals);

    const fs = await import("fs");
    const sidebarSrc = fs.readFileSync("components/layout/sidebar.tsx", "utf-8");
    const projectsPageSrc = fs.readFileSync("app/(main)/projects/page.tsx", "utf-8");
    const projectsNewSrc = fs.readFileSync("app/(main)/projects/new/page.tsx", "utf-8");
    const activitiesNewSrc = fs.readFileSync("app/(main)/activities/new/page.tsx", "utf-8");
    const ticketsNewSrc = fs.readFileSync("app/(main)/tickets/new/page.tsx", "utf-8");
    check("20. Sidebar's 'New Project' link has its own visible gate (navFlags.canCreateProjects), not just parent visibility", /New Project.*\n.*canCreateProjects|canCreateProjects.*\n.*New Project/.test(sidebarSrc) || sidebarSrc.includes('href: "/projects/new", visible: navFlags.canCreateProjects'));
    check("20. Sidebar's 'New Activity' link has its own visible gate (navFlags.canCreateActivities)", sidebarSrc.includes('href: "/activities/new", visible: navFlags.canCreateActivities'));
    check("20. app/(main)/projects/page.tsx's New Project button is now conditionally rendered (canCreate &&)", projectsPageSrc.includes("{canCreate && ("));
    check("20. app/(main)/projects/new/page.tsx sources canCreate from getNavVisibilityFlags(...).canCreateProjects", projectsNewSrc.includes(".canCreateProjects"));
    check("20. app/(main)/activities/new/page.tsx now has an activity.create gate (previously had none)", activitiesNewSrc.includes(".canCreateActivities"));
    check("20. app/(main)/tickets/new/page.tsx sources canCreate from getNavVisibilityFlags(...).canCreateTickets", ticketsNewSrc.includes(".canCreateTickets"));

    // ══════════════ Extra: "unauthenticated" and department-leakage sanity on the API layer ══════════════
    console.log("\n=== Extra: cross-department leakage — create in a department the user has NO membership in must still 403 ═══\n");
    const otherDept = await makeDept("OtherDeptNoMembership");
    const activityLeakRes = await activitiesPOST(jsonReq("http://localhost/api/activities", { title: `Leak test ${RUN_ID}`, departmentId: otherDept.id }));
    check("Extra. POST /api/activities into an unrelated department (no membership there) -> 403 even though activity.create IS granted in the user's OWN department", activityLeakRes.status === 403);
    const otherDeptActivityCount = await prisma.projectActivity.count({ where: { departmentId: otherDept.id } });
    check("Extra. Zero Activity rows created in the unrelated department", otherDeptActivityCount === 0);
  } finally {
    await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
    await prisma.ticketStatus.deleteMany({ where: { id: { in: ticketStatusIds } } });
    await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
    // createDepartment() (used by makeDept above) atomically provisions a
    // full starter-config row set (TicketCategory/TicketPriority (+
    // SlaPolicy, cascades with its TicketPriority)/TicketStatus/
    // ActivityProgressConfig/ProjectStatusConfig/ActivityStatusConfig/
    // ActivityPriorityConfig) — none of these cascade-delete with the
    // Department row itself (see prisma/schema.prisma), so they must be
    // cleaned up explicitly first, same as scripts/test-activity-progress-
    // department-isolation.ts's own cleanup does.
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
    await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
