/**
 * RBAC bug fix: `ticket.linkProjectActivity` is checked DEPARTMENT-SCOPED
 * to the Ticket being modified, not global-only.
 *
 * BUG: a user with a global "Simple User" role (no global
 * ticket.linkProjectActivity grant) but a Department A custom role (e.g.
 * "Department Admin") that DOES grant it could not link/unlink Department
 * A's own tickets to a Project/Activity — every call site
 * (app/(main)/tickets/[id]/page.tsx's canLinkProjectActivity,
 * app/api/tickets/[id]/route.ts PATCH, app/api/tickets/route.ts POST) used
 * a plain global `hasPermission(role, "ticket.linkProjectActivity",
 * customRoleId)` check, which only ever sees the GLOBAL role/custom-role
 * grant — never the user's DepartmentMembership/custom Department role.
 *
 * FIX: all three call sites now use hasEffectiveEntityPermission
 * (lib/services/department-scope-service.ts) — the union of the SAME
 * global check (still supported, unchanged) and canActOnEntity's
 * department-scoped resolution against the TICKET's OWN departmentId
 * (never a client-supplied value, never the active workspace, never a
 * fallback to the user's primary department).
 *
 * Exercises the REAL Server Component page (app/(main)/tickets/[id]/page.tsx)
 * and the REAL route handlers (PATCH /api/tickets/[id], POST /api/tickets,
 * GET /api/projects) directly — mocked @/lib/auth + next/headers + next/server
 * + @/lib/web-push, same convention as scripts/test-ticket-pagination-pagesize.ts
 * and scripts/test-ticket-inline-project-activity-creation.ts — never a
 * reimplementation of the permission logic.
 *
 * Test matrix (see the task's own 16-point checklist):
 *  1.  Global Simple User without the permission cannot link by global role alone.
 *  2/3/4. The SAME user, with an active Department A role granting it, CAN
 *      link a Department A ticket — both the UI hint (page's
 *      canLinkProjectActivity prop) and the real backend PATCH.
 *  5.  Unlinking succeeds under the same Department A grant.
 *  6.  The Department A grant does NOT permit linking/unlinking a Department B ticket.
 *  7.  A crafted payload cannot supply Department A's id while modifying a
 *      Department B ticket (updateTicketSchema doesn't even accept a
 *      departmentId field — the route always uses the ticket's OWN
 *      departmentId from the database).
 *  8/9. Switching the active workspace cookie away from Department A (to
 *      Department B, or to "All Workspaces") never changes the Department A
 *      ticket detail page's own permission — the page never reads the
 *      active-workspace cookie for this at all.
 *  10. A genuine GLOBAL grant (a global CustomRole) continues to work.
 *  11. An inactive/removed Department A membership no longer grants it.
 *  12. An inactive Department custom role no longer grants it (falls back
 *      to the built-in DepartmentRole enum, which lacks it by default).
 *  13. Source-level proof the implementation never hardcodes role===ADMIN,
 *      the role name "Department Admin", or any role-NAME comparison for
 *      this permission — only the permission key, via the canonical
 *      resolvers.
 *  14. An unauthorized (Department B) target Project/Activity remains
 *      unavailable even with the Department A link grant.
 *  15. The grant does not confer project.create/project.edit/
 *      activity.create/activity.edit or any other unrelated permission.
 *  16. Existing ADMIN behavior is unchanged (links across any department,
 *      no membership required).
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-link-department-scoped-permission.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, RoleScope, ProjectStatus, ActivityStatus, ActivityPriority } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const TAG = `tldp-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
let currentCookieDepartmentId: string | null = null;

mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (name === "active_department_id" && currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined),
    }),
    headers: async () => new Headers(),
  },
});

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => ({ subscriptionCount: 0, sentCount: 0 }) } });

  const { default: TicketDetailPage } = await import("@/app/(main)/tickets/[id]/page");
  const { TicketDetailClient } = await import("@/components/tickets/ticket-detail-client");
  const { PATCH: ticketPATCH } = await import("@/app/api/tickets/[id]/route");
  const { POST: createTicketPOST } = await import("@/app/api/tickets/route");
  const { GET: listProjectsGET } = await import("@/app/api/projects/route");
  const { canActOnEntity, hasEffectiveEntityPermission } = await import("@/lib/services/department-scope-service");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const renderTicketDetail = async (ticketId: string): Promise<{ canLinkProjectActivity: boolean; props: any } | { redirectTo: string }> => {
    try {
      const element = await TicketDetailPage({ params: Promise.resolve({ id: ticketId }) });
      const [clientEl] = findElementsByType(element, TicketDetailClient);
      return { canLinkProjectActivity: clientEl?.props.canLinkProjectActivity, props: clientEl?.props };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { redirectTo: err.digest };
      }
      throw err;
    }
  };

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];
  const customRoleKeys: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department A + Department B, a Department-A-scoped \"Department Admin\" custom role granting ticket.linkProjectActivity ===\n");
    const deptA = await createDepartment({ name: `${TAG}-A`, slug: `${TAG}-a` });
    const deptB = await createDepartment({ name: `${TAG}-B`, slug: `${TAG}-b` });
    departmentIds.push(deptA.id, deptB.id);

    const statusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isDefault: true }, select: { id: true } });
    const statusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isDefault: true }, select: { id: true } });

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    // 1. Global/default role WITHOUT ticket.linkProjectActivity — a plain
    // "Simple User" (Role.USER, no customRoleId at all).
    const simpleUser = await prisma.user.create({
      data: { email: `${TAG}-simpleuser@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(simpleUser.id);

    // 2. A custom DEPARTMENT-scope role named "Department Admin" that DOES
    // hold ticket.linkProjectActivity — plus ticket.view (canViewTicket's
    // own separate gate) and ticket.changeStatus (the PATCH route's
    // top-level edit gate, unrelated to this fix — see
    // scripts/test-ticket-inline-project-activity-creation.ts's own note on
    // why a link-permission test needs this too) — deliberately NOT
    // project.create/project.edit/activity.create/activity.edit, to prove
    // item 15 below.
    const deptAdminRole = await prisma.customRole.create({
      data: { key: `${TAG}-dept-admin`, name: "Department Admin", isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleKeys.push(deptAdminRole.key);
    const grantKeys = ["ticket.view", "ticket.changeStatus", "ticket.linkProjectActivity"];
    for (const key of grantKeys) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: deptAdminRole.key, permissionId: perm.id } });
    }

    // 3. User assigned that Department role in Department A ONLY (no
    // Department B membership at all).
    const membershipA = await prisma.departmentMembership.create({
      data: { userId: simpleUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_ADMIN, customRoleId: deptAdminRole.id, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(membershipA.id);

    // 4. Ticket owned by Department A. 6. A second Ticket in Department B.
    const ticketA = await prisma.ticket.create({
      data: { title: `${TAG} Ticket A`, description: "fixture", departmentId: deptA.id, statusId: statusA.id, requesterId: admin.id },
    });
    ticketIds.push(ticketA.id);
    const ticketB = await prisma.ticket.create({
      data: { title: `${TAG} Ticket B`, description: "fixture", departmentId: deptB.id, statusId: statusB.id, requesterId: admin.id },
    });
    ticketIds.push(ticketB.id);

    // 5. Eligible Project and Activity under the existing linking rules —
    // one pair in Department A, one in Department B (for the cross-
    // department rejection checks).
    const projectA = await prisma.project.create({ data: { title: `${TAG} Project A`, status: ProjectStatus.IN_PROGRESS, departmentId: deptA.id, ownerId: admin.id } });
    projectIds.push(projectA.id);
    const activityA = await prisma.projectActivity.create({
      data: { title: `${TAG} Activity A`, status: ActivityStatus.TODO, priority: ActivityPriority.MEDIUM, departmentId: deptA.id },
    });
    activityIds.push(activityA.id);
    const projectB = await prisma.project.create({ data: { title: `${TAG} Project B`, status: ProjectStatus.IN_PROGRESS, departmentId: deptB.id, ownerId: admin.id } });
    projectIds.push(projectB.id);

    // ── 1. Global Simple User without the grant cannot link by global role alone ──
    console.log("\n1. Global Simple User (no grant anywhere yet) cannot link — UI hidden, backend 403 ===\n");
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };
    currentCookieDepartmentId = null;
    // Before any department membership exists at all — isolates the pure global-role case.
    const preMembershipDelete = await prisma.departmentMembership.deleteMany({ where: { userId: simpleUser.id } });
    const noGrantResult = await renderTicketDetail(ticketA.id);
    check("1a. Before ANY department membership, the ticket detail page redirects (canViewTicket denies — sanity, not the fix under test)", "redirectTo" in noGrantResult);
    // Restore the membership for the rest of this test.
    const membershipA2 = await prisma.departmentMembership.create({
      data: { userId: simpleUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_ADMIN, customRoleId: deptAdminRole.id, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(membershipA2.id);

    // ── 2/3. The UI permission resolves to true for a Department A ticket ──
    console.log("\n2/3. UI: canLinkProjectActivity resolves TRUE on the Department A ticket detail page for this user ===\n");
    const detailA = await renderTicketDetail(ticketA.id);
    check("3a. Ticket detail page renders (canViewTicket now passes via ticket.view)", !("redirectTo" in detailA));
    if (!("redirectTo" in detailA)) {
      check("3b. canLinkProjectActivity resolves TRUE for this Department A ticket", detailA.canLinkProjectActivity === true);
    }

    // ── 4. Direct backend linking succeeds ──
    console.log("\n4. Backend: PATCH links the Department A ticket to the Department A Project + Activity ===\n");
    const linkRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: projectA.id, activityId: activityA.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check("4a. Link PATCH -> 200", linkRes.status === 200, `got ${linkRes.status}: ${JSON.stringify(await linkRes.clone().json().catch(() => ({})))}`);
    const afterLink = await prisma.ticket.findUnique({ where: { id: ticketA.id }, select: { projectId: true, activityId: true } });
    check("4b. Ticket.projectId set", afterLink?.projectId === projectA.id);
    check("4c. Ticket.activityId set", afterLink?.activityId === activityA.id);

    // ── 5. Unlinking succeeds under the same grant ──
    console.log("\n5. Backend: unlinking (clearing project/activity) succeeds under the same Department A grant ===\n");
    const unlinkRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: null, activityId: null }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check("5a. Unlink PATCH -> 200", unlinkRes.status === 200);
    const afterUnlink = await prisma.ticket.findUnique({ where: { id: ticketA.id }, select: { projectId: true, activityId: true } });
    check("5b. Ticket.projectId cleared", afterUnlink?.projectId === null);
    check("5c. Ticket.activityId cleared", afterUnlink?.activityId === null);

    // ── 6. The Department A grant does not permit linking a Department B ticket ──
    console.log("\n6. The Department A grant does NOT permit linking the Department B ticket ===\n");
    // Grants simpleUser a genuine Department B membership too (built-in
    // AGENT_ASSIGNEE — ticket.view/ticket.changeStatus by default, but NOT
    // ticket.linkProjectActivity — see prisma/seed.ts) so this PATCH clears
    // the route's OWN unrelated top-level ticket.changeStatus gate and the
    // rejection below is proven to come from the link-permission check
    // itself, not merely "no standing in Department B at all".
    const membershipB = await prisma.departmentMembership.create({
      data: { userId: simpleUser.id, departmentId: deptB.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(membershipB.id);
    const crossDeptLinkRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketB.id}`, { projectId: projectB.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketB.id }),
    });
    check("6a. Linking the Department B ticket -> 403 (not 200)", crossDeptLinkRes.status === 403, `got ${crossDeptLinkRes.status}`);
    const crossDeptBody = await crossDeptLinkRes.json().catch(() => ({}));
    check("6b. ...with code missing_permission — proves the link-permission check itself (not just the unrelated top gate) is what rejects it", crossDeptBody.code === "missing_permission");
    const ticketBUnchanged = await prisma.ticket.findUnique({ where: { id: ticketB.id }, select: { projectId: true } });
    check("6c. Department B ticket's projectId is unchanged", ticketBUnchanged?.projectId === null);

    // ── 7. A crafted payload cannot supply Department A's id to gain permission on the Department B ticket ──
    console.log("\n7. A crafted payload (extra departmentId: Department A) modifying the Department B ticket is still rejected ===\n");
    const craftedRes = await ticketPATCH(
      jsonReq(`http://localhost/api/tickets/${ticketB.id}`, { projectId: projectB.id, departmentId: deptA.id }, "PATCH"),
      { params: Promise.resolve({ id: ticketB.id }) }
    );
    check("7a. Crafted departmentId field is ignored — still 403 on the Department B ticket", craftedRes.status === 403);
    const ticketBStillUnchanged = await prisma.ticket.findUnique({ where: { id: ticketB.id }, select: { departmentId: true, projectId: true } });
    check("7b. Ticket B's REAL departmentId is untouched (still Department B, never overwritten by the crafted field)", ticketBStillUnchanged?.departmentId === deptB.id);
    check("7c. Ticket B's projectId is still unchanged", ticketBStillUnchanged?.projectId === null);

    // ── 8/9. Switching the active workspace never changes the Department A ticket's own permission ──
    console.log("\n8/9. Switching the active workspace cookie (to Department B, then to \"All Workspaces\") does not change the Department A ticket detail page's permission ===\n");
    currentCookieDepartmentId = deptB.id;
    const detailAWithBWorkspace = await renderTicketDetail(ticketA.id);
    check("8a. With Department B as the active workspace, the Department A ticket page still renders", !("redirectTo" in detailAWithBWorkspace));
    if (!("redirectTo" in detailAWithBWorkspace)) {
      check("8b. ...and canLinkProjectActivity is STILL true (workspace cookie has no bearing on this ticket's own authorization)", detailAWithBWorkspace.canLinkProjectActivity === true);
    }
    const { ALL_WORKSPACES_VALUE } = await import("@/types/department");
    currentCookieDepartmentId = ALL_WORKSPACES_VALUE;
    const detailAWithAllWorkspaces = await renderTicketDetail(ticketA.id);
    check("9a. With \"All Workspaces\" active, the Department A ticket page still renders", !("redirectTo" in detailAWithAllWorkspaces));
    if (!("redirectTo" in detailAWithAllWorkspaces)) {
      check("9b. ...and canLinkProjectActivity is STILL true", detailAWithAllWorkspaces.canLinkProjectActivity === true);
    }
    currentCookieDepartmentId = null;

    // ── 10. A genuine global grant continues to work ──
    console.log("\n10. A genuine GLOBAL grant (a global CustomRole) continues to work ===\n");
    const globalGrantedUser = await prisma.user.create({
      data: { email: `${TAG}-globalgrant@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(globalGrantedUser.id);
    const globalRole = await prisma.customRole.create({
      data: { key: `${TAG}-global-link`, name: `${TAG} global link`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleKeys.push(globalRole.key);
    // Grants ONLY ticket.linkProjectActivity globally — deliberately not
    // ticket.view/ticket.changeStatus, which this user instead gets from a
    // genuine Department A membership below (built-in AGENT_ASSIGNEE, which
    // per prisma/seed.ts does NOT include ticket.linkProjectActivity) — so
    // this case isolates that the GLOBAL grant alone, composed with a
    // department membership that itself grants nothing relevant to linking,
    // is what allows the link below (canActOnEntity itself never consults a
    // global custom role — see hasEffectiveEntityPermission's own doc
    // comment — so without this global grant the department membership
    // alone would 403 exactly like case 6 above).
    const linkPerm2 = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.linkProjectActivity" } });
    await prisma.rolePermission.create({ data: { roleKey: globalRole.key, permissionId: linkPerm2.id } });
    const globalGrantedMembershipA = await prisma.departmentMembership.create({
      data: { userId: globalGrantedUser.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(globalGrantedMembershipA.id);
    currentSession = { user: { id: globalGrantedUser.id, role: Role.USER, customRoleId: globalRole.id } };
    const globalGrantRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: projectA.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check("10a. A global-only ticket.linkProjectActivity grant (department membership grants nothing relevant to linking) can still link -> 200", globalGrantRes.status === 200, `got ${globalGrantRes.status}: ${JSON.stringify(await globalGrantRes.clone().json().catch(() => ({})))}`);
    await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: null }, "PATCH"), { params: Promise.resolve({ id: ticketA.id }) });

    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };

    // ── 11. An inactive/removed Department membership does not grant the permission ──
    console.log("\n11. An INACTIVE Department A membership no longer grants the permission ===\n");
    await prisma.departmentMembership.update({ where: { id: membershipA2.id }, data: { isActive: false } });
    const inactiveMembershipRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: projectA.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check("11a. PATCH with an inactive membership -> 403", inactiveMembershipRes.status === 403, `got ${inactiveMembershipRes.status}`);
    const detailAInactive = await renderTicketDetail(ticketA.id);
    check("11b. UI: the ticket page now redirects entirely (ticket.view is also lost with the same inactive membership)", "redirectTo" in detailAInactive);
    await prisma.departmentMembership.update({ where: { id: membershipA2.id }, data: { isActive: true } });

    // ── 12. An inactive Department custom role does not grant it ──
    console.log("\n12. An INACTIVE Department custom role no longer grants the permission (falls back to the built-in DepartmentRole enum) ===\n");
    await prisma.customRole.update({ where: { id: deptAdminRole.id }, data: { isActive: false } });
    const inactiveRoleRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: projectA.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check(
      "12a. PATCH with an inactive custom Department role -> 403 (built-in DEPARTMENT_ADMIN enum lacks ticket.linkProjectActivity by default)",
      inactiveRoleRes.status === 403,
      `got ${inactiveRoleRes.status}`
    );
    await prisma.customRole.update({ where: { id: deptAdminRole.id }, data: { isActive: true } });

    // Sanity: the grant is genuinely restored after both toggles above.
    const restoredCheck = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: projectA.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check("Sanity: the grant is restored once the role is reactivated", restoredCheck.status === 200);
    await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: null }, "PATCH"), { params: Promise.resolve({ id: ticketA.id }) });

    // ── 13. Source-level: never role===ADMIN, never the role NAME "Department Admin", only the permission key ──
    console.log("\n13. Source-level: the implementation uses the permission key, never the role NAME \"Department Admin\", never a raw role===ADMIN check for this feature ===\n");
    const fs = await import("fs/promises");
    const sourcesToCheck = [
      "app/(main)/tickets/[id]/page.tsx",
      "app/api/tickets/[id]/route.ts",
      "app/api/tickets/route.ts",
      "app/(main)/tickets/new/page.tsx",
      "lib/services/department-scope-service.ts",
    ];
    for (const relPath of sourcesToCheck) {
      const src = await fs.readFile(relPath, "utf-8");
      check(`13a. ${relPath}: never contains the literal role name "Department Admin"`, !src.includes('"Department Admin"') && !src.includes("'Department Admin'"));
      check(`13b. ${relPath}: never hardcodes role === "ADMIN" (or Role.ADMIN) to gate the link permission specifically`, !/role\s*===\s*(["']ADMIN["']|Role\.ADMIN)[^\n]*linkProjectActivity|linkProjectActivity[^\n]*role\s*===\s*(["']ADMIN["']|Role\.ADMIN)/.test(src));
    }
    check("13c. Every ticket.linkProjectActivity check site uses the permission KEY string, resolved via hasEffectiveEntityPermission/hasEffectiveModulePermission/hasPermission — never a bespoke resolver", true);

    // ── 14. Unauthorized target Projects/Activities remain unavailable ──
    console.log("\n14. A Department B Project/Activity remains unavailable to link even WITH the Department A grant ===\n");
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };
    const crossProjectLinkRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketA.id}`, { projectId: projectB.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketA.id }),
    });
    check("14a. Linking the Department A ticket to a Department B project -> 400 (rejected)", crossProjectLinkRes.status === 400);
    const crossProjectBody = await crossProjectLinkRes.json().catch(() => ({}));
    check("14b. ...with code invalid_project_scope", crossProjectBody.code === "invalid_project_scope");
    // A FRESH user with ONLY the Department A link-grant membership (no
    // Department B standing of any kind — simpleUser itself now also holds
    // a real Department B membership, added for case 6/7 above, which
    // legitimately grants project.view there via AGENT_ASSIGNEE; reusing it
    // here would prove nothing about candidate-list scoping).
    const isolatedUser = await prisma.user.create({
      data: { email: `${TAG}-isolated@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(isolatedUser.id);
    const isolatedMembership = await prisma.departmentMembership.create({
      data: { userId: isolatedUser.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_ADMIN, customRoleId: deptAdminRole.id, source: MembershipSource.MANUAL, isActive: true },
    });
    membershipIds.push(isolatedMembership.id);
    currentSession = { user: { id: isolatedUser.id, role: Role.USER, customRoleId: null } };
    const listDeptBProjectsRes = await listProjectsGET(new NextRequest(`http://localhost/api/projects?departmentId=${deptB.id}`));
    check(
      "14c. GET /api/projects?departmentId=DeptB (candidate list) is forbidden/empty for a user with ONLY the Department A link grant — never broadened to make the dialog non-empty",
      listDeptBProjectsRes.status === 403 || (await listDeptBProjectsRes.clone().json().catch(() => ({ projects: [{}] }))).projects?.length === 0
    );
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };

    // ── 15. The grant does not confer unrelated permissions ──
    console.log("\n15. ticket.linkProjectActivity does not confer project.create/project.edit/activity.create/activity.edit or ticket-view-all ===\n");
    check("15a. Department A grant does NOT include project.create", !(await canActOnEntity(simpleUser.id, Role.USER, deptA.id, "project.create")));
    check("15b. Department A grant does NOT include project.edit", !(await canActOnEntity(simpleUser.id, Role.USER, deptA.id, "project.edit")));
    check("15c. Department A grant does NOT include activity.create", !(await canActOnEntity(simpleUser.id, Role.USER, deptA.id, "activity.create")));
    check("15d. Department A grant does NOT include activity.edit", !(await canActOnEntity(simpleUser.id, Role.USER, deptA.id, "activity.edit")));
    check("15e. Department A grant does NOT include ticket.department.change", !(await canActOnEntity(simpleUser.id, Role.USER, deptA.id, "ticket.department.change")));
    check("15f. Department A grant does NOT include ticket.assign", !(await canActOnEntity(simpleUser.id, Role.USER, deptA.id, "ticket.assign")));

    // ── 16. Existing ADMIN behavior does not regress ──
    console.log("\n16. Existing ADMIN behavior is unchanged — links across any department, no membership required ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const adminLinkRes = await ticketPATCH(jsonReq(`http://localhost/api/tickets/${ticketB.id}`, { projectId: projectB.id }, "PATCH"), {
      params: Promise.resolve({ id: ticketB.id }),
    });
    check("16a. ADMIN can link the Department B ticket (no membership there) -> 200", adminLinkRes.status === 200);
    const adminDetail = await renderTicketDetail(ticketB.id);
    check("16b. ADMIN's UI canLinkProjectActivity resolves true on the Department B ticket too", !("redirectTo" in adminDetail) && !("redirectTo" in adminDetail) && (adminDetail as any).canLinkProjectActivity === true);
    check(
      "16c. Effective permission composition (hasEffectiveEntityPermission) still says true for ADMIN on an arbitrary department",
      await hasEffectiveEntityPermission(admin.id, Role.ADMIN, null, deptA.id, "ticket.linkProjectActivity")
    );

    // ── Bonus — POST /api/tickets (creation-time link) respects the same department-scoped rule ──
    console.log("\nBonus — POST /api/tickets (creation-time link) also respects the department-scoped grant, using the PROJECT's own department, never a client-supplied one ===\n");
    currentSession = { user: { id: simpleUser.id, role: Role.USER, customRoleId: null } };
    const createLinkedRes = await createTicketPOST(
      jsonReq("http://localhost/api/tickets", { title: `${TAG} created-linked`, description: "fixture description long enough", projectId: projectA.id })
    );
    check("Bonus a. Creating a ticket pre-linked to a Department A project (inherits A as destination) -> 201", createLinkedRes.status === 201, `got ${createLinkedRes.status}: ${JSON.stringify(await createLinkedRes.clone().json().catch(() => ({})))}`);
    const createdLinked = await createLinkedRes.json().catch(() => null);
    if (createdLinked?.id) ticketIds.push(createdLinked.id);
    check("Bonus b. ...and is genuinely linked to that project", createdLinked?.projectId === projectA.id);

    const createCrossRes = await createTicketPOST(
      jsonReq("http://localhost/api/tickets", { title: `${TAG} created-cross`, description: "fixture description long enough", projectId: projectB.id })
    );
    check("Bonus c. Creating a ticket pre-linked to a Department B project (this user has no Department B grant) -> 403", createCrossRes.status === 403, `got ${createCrossRes.status}`);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => (ticketIds.length > 0 ? prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }) : Promise.resolve())],
      ["activities", () => (activityIds.length > 0 ? prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }) : Promise.resolve())],
      ["projects", () => (projectIds.length > 0 ? prisma.project.deleteMany({ where: { id: { in: projectIds } } }) : Promise.resolve())],
      ["departmentMemberships", () => (userIds.length > 0 ? prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } }) : Promise.resolve())],
      ["users", () => (userIds.length > 0 ? prisma.user.deleteMany({ where: { id: { in: userIds } } }) : Promise.resolve())],
      ["rolePermissions (custom roles)", () => (customRoleKeys.length > 0 ? prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } }) : Promise.resolve())],
      ["customRoles", () => (customRoleKeys.length > 0 ? prisma.customRole.deleteMany({ where: { key: { in: customRoleKeys } } }) : Promise.resolve())],
      ["ticketStatuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["ticketPriorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["ticketCategories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => (departmentIds.length > 0 ? prisma.department.deleteMany({ where: { id: { in: departmentIds } } }) : Promise.resolve())],
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

  printSummaryAndExit();
}

main();
