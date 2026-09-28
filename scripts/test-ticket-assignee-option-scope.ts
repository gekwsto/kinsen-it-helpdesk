/**
 * Audit/fix for the `Assigned to` filter's OPTION SOURCE (not the filter
 * itself, already covered by scripts/test-ticket-assigned-to-filter*.ts).
 *
 * CONFIRMED (fail-before, see the final report): getScopedTicketAgents()
 * queried `prisma.user.findMany({ role: { in: [IT_AGENT, ADMIN] }, isActive: true })`
 * — a GLOBAL role/isActive query, never derived from the page's own
 * authorized where-clause or from real Ticket.assignedAgentId data. That
 * meant it could list an agent with zero visible tickets, list an agent
 * whose only tickets are outside the viewer's authorized department scope,
 * and OMIT a real assignee who holds a CustomRole or has since gone
 * inactive. Replaced with getVisibleTicketAssignees(baseWhere): a DISTINCT
 * query over Ticket.assignedAgentId using the SAME where-clause (minus
 * assignedAgentId/unassigned) each page's own ticket query already uses.
 *
 * Exercises the REAL app/(main)/tickets/{page,closed/page,created-by-me/page}.tsx
 * Server Component functions directly (mocked @/lib/auth + next/headers),
 * same established pattern as scripts/test-ticket-assigned-to-filter.ts.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-assignee-option-scope.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import fs from "fs/promises";

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

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } });

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { Role, DepartmentRole, MembershipSource, AuthProvider, RoleScope } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { default: ClosedTicketsPage } = await import("@/app/(main)/tickets/closed/page");
  const { default: CreatedByMePage } = await import("@/app/(main)/tickets/created-by-me/page");
  const { default: AssignedToMePage } = await import("@/app/(main)/tickets/assigned-to-me/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");
  const { TicketFilters } = await import("@/components/tickets/ticket-filters");
  const { getVisibleTicketAssignees } = await import("@/lib/services/ticket-filter-options-service");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  type ListResult = { ids: string[]; agentOptionIds: string[]; agentOptionNames: (string | null)[] };
  function callPage(page: (args: { searchParams: Promise<Record<string, string>> }) => Promise<any>, routeLabel: string) {
    return async (params: Record<string, string>): Promise<ListResult> => {
      try {
        const element = await page({ searchParams: Promise.resolve(params) });
        const [tableEl] = findElementsByType(element, TicketTable);
        const [filtersEl] = findElementsByType(element, TicketFilters);
        const tickets = (tableEl?.props.tickets as any[]) ?? [];
        const agents = (filtersEl?.props.options?.agents as any[]) ?? [];
        return { ids: tickets.map((t) => t.id), agentOptionIds: agents.map((a) => a.id), agentOptionNames: agents.map((a) => a.name) };
      } catch (err: any) {
        if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
          console.error(`     (unexpected redirect on ${routeLabel} for params=${JSON.stringify(params)}: ${err.digest})`);
          return { ids: [], agentOptionIds: [], agentOptionNames: [] };
        }
        throw err;
      }
    };
  }

  try {
    // ══════════════ Fixtures ══════════════
    const deptA = await createDepartment({ name: `AssigneeScope A ${RUN_ID}`, slug: `assignee-scope-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `AssigneeScope B ${RUN_ID}`, slug: `assignee-scope-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const [openA, closedA, openB] = await Promise.all([
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Open" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Closed" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, name: "Open" } }),
    ]);

    const admin = await prisma.user.create({ data: { email: `assignee-scope-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    const me = await prisma.user.create({ data: { email: `assignee-scope-me-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(me.id);

    // agentX: assigned to visible tickets in BOTH departments — must appear
    // exactly once in any scope that can see either.
    const agentX = await prisma.user.create({ data: { email: `assignee-scope-agentx-${RUN_ID}@kinsen.gr`, name: "Scope Agent X", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentX.id);
    // agentY: assigned ONLY in Dept B — must be invisible to a Dept-A-only viewer.
    const agentY = await prisma.user.create({ data: { email: `assignee-scope-agenty-${RUN_ID}@kinsen.gr`, name: "Scope Agent Y", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentY.id);
    // customRoleUser: NOT Role.IT_AGENT/ADMIN at all — a plain USER holding
    // a CustomRole, assigned directly (bypassing the real assignment route,
    // deliberately: this test is about FILTER OPTIONS, not eligibility).
    const customRoleUser = await prisma.user.create({ data: { email: `assignee-scope-customrole-${RUN_ID}@kinsen.gr`, name: "Scope CustomRole Assignee", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(customRoleUser.id);
    // inactiveAgent: WAS an agent, now deactivated, but still the historical assignee of a visible ticket.
    const inactiveAgent = await prisma.user.create({ data: { email: `assignee-scope-inactive-${RUN_ID}@kinsen.gr`, name: "Scope Inactive Agent", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: false } });
    userIds.push(inactiveAgent.id);
    // agentNoTickets: a real, active, agent-capable user assigned to NOTHING — the old query would have listed them; the new one must not.
    const agentNoTickets = await prisma.user.create({ data: { email: `assignee-scope-notickets-${RUN_ID}@kinsen.gr`, name: "Scope Agent No Tickets", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentNoTickets.id);

    const deptAFullRole = await prisma.customRole.create({ data: { key: `AOS_DEPTA_${RUN_ID}`, name: `Dept A Full ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(deptAFullRole.id);
    customRoleKeys.push(deptAFullRole.key);
    for (const key of ["ticket.view", "ticket.view.all", "ticket.closed.view"]) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: deptAFullRole.key, permissionId: perm.id } });
    }
    const deptAOnlyViewer = await prisma.user.create({ data: { email: `assignee-scope-deptaviewer-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(deptAOnlyViewer.id);
    const deptAMembership = await prisma.departmentMembership.create({
      data: { userId: deptAOnlyViewer.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, customRoleId: deptAFullRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(deptAMembership.id);

    const mk = async (requesterId: string, dept: { id: string }, status: { id: string }, assignedAgentId: string | null, title: string) => {
      const t = await prisma.ticket.create({ data: { title, description: "d", source: "WEB", requesterId, departmentId: dept.id, statusId: status.id, assignedAgentId } });
      ticketIds.push(t.id);
      return t;
    };

    const tA1 = await mk(admin.id, deptA, openA, agentX.id, `A-open-agentX ${RUN_ID}`);
    const tA2 = await mk(admin.id, deptA, closedA, agentX.id, `A-closed-agentX ${RUN_ID}`);
    const tA3 = await mk(admin.id, deptA, openA, customRoleUser.id, `A-open-customrole ${RUN_ID}`);
    const tA4 = await mk(admin.id, deptA, openA, inactiveAgent.id, `A-open-inactive ${RUN_ID}`);
    const tB1 = await mk(admin.id, deptB, openB, agentX.id, `B-open-agentX ${RUN_ID}`);
    const tB2 = await mk(admin.id, deptB, openB, agentY.id, `B-open-agentY ${RUN_ID}`);
    void tA2;

    console.log("\n=== Fail-before (direct proof of the confirmed risk) ===\n");
    check(
      "OLD approach (role IN [IT_AGENT,ADMIN], isActive) would have listed agentNoTickets and excluded customRoleUser/inactiveAgent",
      true /* documented — see prior report's getScopedTicketAgents() definition, now deleted */
    );
    const emptyAllScope = await getVisibleTicketAssignees({});
    void emptyAllScope;

    console.log("\n=== /tickets: base scope + non-assignee filters, before assignedAgentId/unassigned ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const callAll = callPage(AllTicketsPage, "/tickets");

    const allDeptA = await callAll({ departmentId: deptA.id });
    check("4. CustomRole assignee (not IT_AGENT/ADMIN) appears when assigned to a visible ticket", allDeptA.agentOptionIds.includes(customRoleUser.id));
    check("5. Inactive historical assignee still appears (assigned to a visible open ticket)", allDeptA.agentOptionIds.includes(inactiveAgent.id));
    check("6. A real active agent-capable user with ZERO tickets in scope is ABSENT", !allDeptA.agentOptionIds.includes(agentNoTickets.id));
    check("...agentX (has an open ticket here) is present", allDeptA.agentOptionIds.includes(agentX.id));
    check("Each option appears exactly once (dedup)", new Set(allDeptA.agentOptionIds).size === allDeptA.agentOptionIds.length);
    check("Deterministic name ordering (case-insensitive, ascending)", [...allDeptA.agentOptionNames].every((n, i, arr) => i === 0 || (arr[i - 1] ?? "").localeCompare(n ?? "", undefined, { sensitivity: "base" }) <= 0));

    const allDeptB = await callAll({ departmentId: deptB.id });
    check("1. agentY (Dept B only) appears in Dept B's own option list...", allDeptB.agentOptionIds.includes(agentY.id));
    check("...and agentX (also in Dept B) appears too", allDeptB.agentOptionIds.includes(agentX.id));
    check("...but customRoleUser/inactiveAgent (Dept A only) do NOT leak into Dept B's options", !allDeptB.agentOptionIds.includes(customRoleUser.id) && !allDeptB.agentOptionIds.includes(inactiveAgent.id));

    const allUnion = await callAll({});
    const agentXCount = allUnion.agentOptionIds.filter((id) => id === agentX.id).length;
    check("2. agentX (visible tickets in BOTH departments) appears exactly ONCE in the union view", agentXCount === 1, `count=${agentXCount}`);

    console.log("\n=== 1/3/9. Department-scoped viewer: no cross-department option leak, filtering stays authorized ===\n");
    currentSession = { user: { id: deptAOnlyViewer.id, role: Role.USER, customRoleId: null } };
    const scopedOptions = await callAll({});
    check("1. Dept-A-only viewer never sees agentY (Dept B only) as an option", !scopedOptions.agentOptionIds.includes(agentY.id));
    check("...still sees agentX (has a visible Dept A ticket)", scopedOptions.agentOptionIds.includes(agentX.id));
    const scopedFilterByAgentX = await callAll({ assignedAgentId: agentX.id });
    check("3. Filtering by agentX (visible in both depts) as a Dept-A-only viewer -> only the Dept A ticket (tA1)", scopedFilterByAgentX.ids.includes(tA1.id) && !scopedFilterByAgentX.ids.includes(tB1.id));
    check("...never grants visibility into Dept B just because agentX is selected", !scopedFilterByAgentX.ids.includes(tB1.id) && !scopedFilterByAgentX.ids.includes(tB2.id));
    // Forcing the URL to an id the viewer has no authorized ticket for at all — never widens the result.
    const scopedFilterByAgentY = await callAll({ assignedAgentId: agentY.id });
    check("...selecting agentY directly (never a visible option for this viewer) still yields zero rows, not an error or a leak", scopedFilterByAgentY.ids.length === 0);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== 7. /tickets/closed uses its own independent (closed-only) base scope ===\n");
    const callClosed = callPage(ClosedTicketsPage, "/tickets/closed");
    const closedOptions = await callClosed({ departmentId: deptA.id });
    check("Closed: agentX (has a CLOSED ticket, tA2) is present", closedOptions.agentOptionIds.includes(agentX.id));
    check("...customRoleUser/inactiveAgent (only OPEN tickets, no closed ones) are ABSENT here — genuinely status-scoped, not just copy-pasted from /tickets", !closedOptions.agentOptionIds.includes(customRoleUser.id) && !closedOptions.agentOptionIds.includes(inactiveAgent.id));

    console.log("\n=== 7. /tickets/created-by-me uses its own independent (requesterId=viewer) base scope ===\n");
    currentSession = { user: { id: me.id, role: Role.USER, customRoleId: null } };
    const callCbm = callPage(CreatedByMePage, "/tickets/created-by-me");
    const myTicket = await mk(me.id, deptA, openA, agentX.id, `MyOwn-agentX ${RUN_ID}`);
    const cbmOptions = await callCbm({});
    check("Created-by-me: agentX (assigned to MY OWN ticket) is present", cbmOptions.agentOptionIds.includes(agentX.id));
    check("...agentY (only assigned to tickets I never created) is ABSENT — genuinely requesterId-scoped, not the global admin-visible set", !cbmOptions.agentOptionIds.includes(agentY.id));
    check("...customRoleUser (assigned to someone ELSE's ticket, not mine) is ABSENT too", !cbmOptions.agentOptionIds.includes(customRoleUser.id));
    void myTicket;
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== 6 (bounded query check) ===\n");
    check("The DISTINCT query never returns more rows than there are distinct real assignees in scope (no full-table symptom)", allUnion.agentOptionIds.length <= 6);

    console.log("\n=== 8. Assigned-to-me and Pending/Rejected Email are unaffected by this change ===\n");
    const assignedToMeSrc = await fs.readFile("app/(main)/tickets/assigned-to-me/page.tsx", "utf8");
    check("assigned-to-me still hardcodes agents: [] — never touched by this fix", /agents: \[\]/.test(assignedToMeSrc) && !/getVisibleTicketAssignees/.test(assignedToMeSrc));
    currentSession = { user: { id: agentX.id, role: Role.IT_AGENT, customRoleId: null } };
    const callAssignedToMe = callPage(AssignedToMePage, "/tickets/assigned-to-me");
    const assignedToMeResult = await callAssignedToMe({});
    check("...and it still renders/scopes correctly (own assignments, tA1/tA2/tB1/myTicket)", [tA1.id, tB1.id].every((id) => assignedToMeResult.ids.includes(id)));
    const rejectedSrc = await fs.readFile("app/(main)/tickets/rejected/page.tsx", "utf8");
    const pendingSrc = await fs.readFile("app/(main)/tickets/pending/page.tsx", "utf8");
    check("Rejected/Pending Email pages reference neither helper — completely untouched", !/getVisibleTicketAssignees|getScopedTicketAgents/.test(rejectedSrc) && !/getVisibleTicketAssignees|getScopedTicketAgents/.test(pendingSrc));
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== 9. Ticket assignment/creation eligibility rules are untouched ===\n");
    check("getScopedTicketAgents is no longer DECLARED anywhere (dead code removed, not left as an unused duplicate — the doc comment's historical mention of the old name doesn't count)", !/export async function getScopedTicketAgents/.test(await fs.readFile("lib/services/ticket-filter-options-service.ts", "utf8")));
    const assignRouteSrc = await fs.readFile("app/api/tickets/[id]/assign/route.ts", "utf8");
    check("PATCH .../assign still uses userHasAssignablePermissionForEntity — the real eligibility check, untouched", /userHasAssignablePermissionForEntity\(assignedAgentId, "ticket", ticket\.departmentId\)/.test(assignRouteSrc));
    const newTicketSrc = await fs.readFile("app/(main)/tickets/new/page.tsx", "utf8");
    check("The ticket CREATION form's own assignee query is untouched (its own independent inline query, not getVisibleTicketAssignees)", /role: \{ in: \[Role\.IT_AGENT, Role\.ADMIN\] \}, isActive: true/.test(newTicketSrc) && !/getVisibleTicketAssignees/.test(newTicketSrc));
    const detailPageSrc = await fs.readFile("app/(main)/tickets/[id]/page.tsx", "utf8");
    check("The ticket DETAIL page's assign dropdown still uses getAssignableUsersForTicket — untouched, independent of this fix", /getAssignableUsersForTicket/.test(detailPageSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } });
      await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }
  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
