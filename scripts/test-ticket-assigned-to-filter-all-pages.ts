/**
 * Extends the "Assigned to" Ticket filter to every real Ticket-list page
 * that renders search/filter controls (not just /tickets):
 *
 *   /tickets              — already had it (scripts/test-ticket-assigned-to-filter.ts)
 *   /tickets/closed       — had the where-clause + agents query, but the
 *                           dropdown was hidden behind `isAllTickets`
 *   /tickets/created-by-me — had neither; both added
 *
 * AUDIT FINDINGS (see the final report):
 *   - /tickets/assigned-to-me is deliberately EXCLUDED: its own base scope
 *     already fixes assignedAgentId to the viewer, so offering a control to
 *     filter by a DIFFERENT assignee would be self-contradictory (always
 *     zero rows) — `agents: []` there is intentional, unchanged.
 *   - /tickets/rejected is NOT a Ticket list at all — it's a PendingTicket
 *     (Pending Email) list, using PendingTicketFilters/PendingTicketTable,
 *     and PendingTicket has no assignedAgentId column whatsoever. It falls
 *     squarely under "Do not add it to Pending Email" despite being named
 *     in the task's own "at minimum" list — left untouched.
 *   - /tickets/pending is the same Pending Email surface — left untouched.
 *
 * Reused, not reimplemented: the same `assignedAgentId`/`unassigned` URL
 * params, the same server-side AND condition shape, the same TicketFilters
 * component (now gated by a new `showAssigneeFilter` prop, independent of
 * the pre-existing `isAllTickets`), and a single new shared query
 * (getVisibleTicketAssignees in lib/services/ticket-filter-options-service.ts —
 * further tightened to real Ticket-scope-derived options in a later pass,
 * see scripts/test-ticket-assignee-option-scope.ts)
 * that replaces what used to be three near-identical inline
 * `prisma.user.findMany({ role: IT_AGENT/ADMIN })` calls.
 *
 * Exercises the REAL Server Component page functions directly (mocked
 * @/lib/auth + next/headers cookies()), same established pattern as
 * scripts/test-ticket-assigned-to-filter.ts.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-assigned-to-filter-all-pages.ts
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
// "ALL" (All Workspaces) for every session — this file tests the
// assignedAgentId filter across pages, a concern orthogonal to workspace
// scoping (see this task's own workspace-scoping fix: Tickets pages now
// default to the active Workspace instead of the full union when no
// cookie is set, which would otherwise scope ADMIN's bare queries here to
// an arbitrary, unrelated department). For a non-canViewAllDepartments
// session (deptAOnlyViewer/me/agentX below), "ALL" simply doesn't match
// any real department id and falls through to their own membership-based
// default, exactly as an absent cookie already did — so this is a safe,
// behavior-preserving default for every session in this file, not just ADMIN.
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: (name: string) => (name === "active_department_id" ? { value: "ALL" } : undefined) }), headers: async () => new Headers() } });

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

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  type ListResult = { ids: string[]; totalCount: number; pageSize: number; agentOptionIds: string[]; filtersProps: any };
  function callPage(page: (args: { searchParams: Promise<Record<string, string>> }) => Promise<any>, routeLabel: string) {
    return async (params: Record<string, string>): Promise<ListResult> => {
      try {
        const element = await page({ searchParams: Promise.resolve(params) });
        const [tableEl] = findElementsByType(element, TicketTable);
        const [filtersEl] = findElementsByType(element, TicketFilters);
        const tickets = (tableEl?.props.tickets as any[]) ?? [];
        return {
          ids: tickets.map((t) => t.id),
          totalCount: tableEl?.props.pagination?.totalCount ?? 0,
          pageSize: tableEl?.props.pagination?.pageSize ?? 0,
          agentOptionIds: ((filtersEl?.props.options?.agents as any[]) ?? []).map((a) => a.id),
          filtersProps: filtersEl?.props,
        };
      } catch (err: any) {
        if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
          console.error(`     (unexpected redirect on ${routeLabel} for params=${JSON.stringify(params)}: ${err.digest})`);
          return { ids: [], totalCount: 0, pageSize: 0, agentOptionIds: [], filtersProps: null };
        }
        throw err;
      }
    };
  }

  try {
    // ══════════════ Fixtures ══════════════
    const deptA = await createDepartment({ name: `AssigneeAll A ${RUN_ID}`, slug: `assignee-all-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `AssigneeAll B ${RUN_ID}`, slug: `assignee-all-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const [openA, inProgressA, closedA, cancelledA, closedB] = await Promise.all([
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Open" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "In Progress" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Closed" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Cancelled" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, name: "Closed" } }),
    ]);

    const admin = await prisma.user.create({ data: { email: `assignee-all-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    const me = await prisma.user.create({ data: { email: `assignee-all-me-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(me.id);
    const agentX = await prisma.user.create({ data: { email: `assignee-all-agentx-${RUN_ID}@kinsen.gr`, name: "AllPages Agent X", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentX.id);
    const agentY = await prisma.user.create({ data: { email: `assignee-all-agenty-${RUN_ID}@kinsen.gr`, name: "AllPages Agent Y", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentY.id);

    const deptAOnlyViewer = await prisma.user.create({ data: { email: `assignee-all-scoped-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(deptAOnlyViewer.id);
    // A plain AGENT_ASSIGNEE membership does NOT include ticket.closed.view
    // (see prisma/seed.ts — deliberately excluded there), so a custom
    // DEPARTMENT-scoped role grants exactly what's needed to reach the
    // Closed Tickets page at all, scoped to Dept A only.
    const closedViewRole = await prisma.customRole.create({ data: { key: `AAF_CLOSEDVIEW_${RUN_ID}`, name: `Closed Viewer ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(closedViewRole.id);
    customRoleKeys.push(closedViewRole.key);
    for (const key of ["ticket.view", "ticket.view.all", "ticket.closed.view"]) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.create({ data: { roleKey: closedViewRole.key, permissionId: perm.id } });
    }
    const scopedMembership = await prisma.departmentMembership.create({
      data: { userId: deptAOnlyViewer.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, customRoleId: closedViewRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(scopedMembership.id);

    const mk = async (requesterId: string, dept: { id: string }, status: { id: string }, assignedAgentId: string | null, title: string) => {
      const t = await prisma.ticket.create({ data: { title, description: "d", source: "WEB", requesterId, departmentId: dept.id, statusId: status.id, assignedAgentId } });
      ticketIds.push(t.id);
      return t;
    };

    console.log("\n=== /tickets/closed ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const callClosed = callPage(ClosedTicketsPage, "/tickets/closed");

    const c1 = await mk(me.id, deptA, closedA, agentX.id, `Closed-A-agentX ${RUN_ID}`);
    const c2 = await mk(me.id, deptA, closedA, agentY.id, `Closed-A-agentY ${RUN_ID}`);
    const c3 = await mk(me.id, deptA, cancelledA, null, `Closed-A-unassigned ${RUN_ID}`);
    const c4 = await mk(me.id, deptB, closedB, agentX.id, `Closed-B-agentX ${RUN_ID}`);

    const closedNoFilter = await callClosed({});
    check("1. Closed: TicketFilters renders with showAssigneeFilter (Assigned to / All assignees)", closedNoFilter.filtersProps?.showAssigneeFilter === true);
    check("...options use stable ids, not name/email", closedNoFilter.agentOptionIds.includes(agentX.id) && closedNoFilter.agentOptionIds.includes(agentY.id));

    const closedByAgentX = await callClosed({ assignedAgentId: agentX.id });
    check("2. Closed: assignedAgentId=agentX filters correctly (c1, c4)", closedByAgentX.ids.includes(c1.id) && closedByAgentX.ids.includes(c4.id));
    check("3. Closed: agentY's ticket (c2) excluded", !closedByAgentX.ids.includes(c2.id));

    const closedUnassigned = await callClosed({ unassigned: "true" });
    check("4. Closed: Only unassigned -> c3, excludes c1/c2/c4", closedUnassigned.ids.includes(c3.id) && !closedUnassigned.ids.includes(c1.id) && !closedUnassigned.ids.includes(c4.id));
    const closedBoth = await callClosed({ assignedAgentId: agentX.id, unassigned: "true" });
    check("4b. Closed: unassigned takes precedence over a simultaneous assignedAgentId (never an impossible AND)", closedBoth.ids.includes(c3.id) && !closedBoth.ids.includes(c1.id));

    const closedCombo = await callClosed({ assignedAgentId: agentX.id, departmentId: deptA.id });
    check("5. Closed: combines with department (c1 only, c4 excluded — dept B)", closedCombo.ids.includes(c1.id) && !closedCombo.ids.includes(c4.id));
    const closedComboStatus = await callClosed({ assignedAgentId: agentX.id, departmentId: deptA.id, statusId: closedA.id });
    check("5b. Closed: combines with status too (still c1)", closedComboStatus.ids.includes(c1.id));
    const closedComboWrongStatus = await callClosed({ assignedAgentId: agentX.id, departmentId: deptA.id, statusId: cancelledA.id });
    check("5c. Closed: a status that doesn't match -> zero rows, not a silent OR", closedComboWrongStatus.ids.length === 0);

    currentSession = { user: { id: deptAOnlyViewer.id, role: Role.USER, customRoleId: null } };
    const closedScoped = await callClosed({ assignedAgentId: agentX.id });
    check("9. Closed: Dept-A-only viewer + assignedAgentId=agentX -> sees c1, never c4 (dept B, unauthorized)", closedScoped.ids.includes(c1.id) && !closedScoped.ids.includes(c4.id));
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== /tickets/created-by-me ===\n");
    const callCreatedByMe = callPage(CreatedByMePage, "/tickets/created-by-me");
    currentSession = { user: { id: me.id, role: Role.USER, customRoleId: null } };

    const m1 = await mk(me.id, deptA, openA, agentX.id, `MyTicket-A-agentX ${RUN_ID}`);
    const m2 = await mk(me.id, deptA, openA, agentY.id, `MyTicket-A-agentY ${RUN_ID}`);
    const m3 = await mk(me.id, deptA, openA, null, `MyTicket-A-unassigned ${RUN_ID}`);
    const m4 = await mk(me.id, deptA, inProgressA, agentX.id, `MyTicket-A-inprogress-agentX ${RUN_ID}`);
    // Someone else's ticket assigned to agentX — must never leak into "created by me" no matter the assignee filter.
    const otherPersonTicket = await mk(admin.id, deptA, openA, agentX.id, `NotMyTicket-agentX ${RUN_ID}`);

    const cbmNoFilter = await callCreatedByMe({});
    check("1. Created-by-me: TicketFilters renders with showAssigneeFilter", cbmNoFilter.filtersProps?.showAssigneeFilter === true);
    check("...a real scoped agents list (not the old hardcoded agents: [])", cbmNoFilter.agentOptionIds.includes(agentX.id) && cbmNoFilter.agentOptionIds.includes(agentY.id));

    const cbmByAgentX = await callCreatedByMe({ assignedAgentId: agentX.id });
    check("2. Created-by-me: assignedAgentId=agentX -> m1 and m4 (my own tickets assigned to X)", cbmByAgentX.ids.includes(m1.id) && cbmByAgentX.ids.includes(m4.id));
    check("3. Created-by-me: agentY's ticket (m2) excluded", !cbmByAgentX.ids.includes(m2.id));
    check("...someone ELSE's ticket assigned to agentX never appears, even filtered by the same assignee — requesterId scope still holds", !cbmByAgentX.ids.includes(otherPersonTicket.id));

    const cbmUnassigned = await callCreatedByMe({ unassigned: "true" });
    check("4. Created-by-me: Only unassigned -> m3 only", cbmUnassigned.ids.includes(m3.id) && !cbmUnassigned.ids.includes(m1.id));

    const cbmCombo = await callCreatedByMe({ assignedAgentId: agentX.id, statusId: openA.id });
    check("5. Created-by-me: combines with status (m1, not m4 which is In Progress)", cbmCombo.ids.includes(m1.id) && !cbmCombo.ids.includes(m4.id));

    console.log("\n=== 8. Clearing removes ONLY the assignee param (source-level — same generic push() every page reuses) ===\n");
    const filtersSrcCheck = await fs.readFile("components/tickets/ticket-filters.tsx", "utf8");
    check("handleSelect(\"assignedAgentId\", \"all\") maps to { assignedAgentId: null } via the SAME generic path every filter uses — no page-specific override", /const handleSelect = \(key: string, value: string\) => \{\s*push\(\{ \[key\]: value === "all" \? null : value \}\);/.test(filtersSrcCheck));

    console.log("\n=== 6/7. Pagination resets on change, preserves the filter across pages (shared, page-agnostic push()/updateParams) ===\n");
    check("6. Changing any filter (incl. assignedAgentId) resets to page 1: push() always deletes \"page\" — same function on every page, not reimplemented per route", /params\.delete\("page"\);/.test(filtersSrcCheck));
    const tableSrc = await fs.readFile("components/tickets/ticket-table.tsx", "utf8");
    check("7. Page-change preserves every other param (assignedAgentId included) — the SAME updateParams every Ticket-list page's <TicketTable> already uses", /const params = new URLSearchParams\(searchParams\.toString\(\)\);/.test(tableSrc));

    console.log("\n=== 10. No unrelated All-Tickets-only controls on Closed / Created-by-me / Assigned-to-me ===\n");
    check("Closed page never passes isAllTickets", !/isAllTickets/.test(await fs.readFile("app/(main)/tickets/closed/page.tsx", "utf8")));
    check("Created-by-me page never passes isAllTickets", !/isAllTickets/.test(await fs.readFile("app/(main)/tickets/created-by-me/page.tsx", "utf8")));
    check("...Closed's <TicketFilters> call site has no currentUserId (no \"Created by me\" toggle wiring)", !/currentUserId/.test(await fs.readFile("app/(main)/tickets/closed/page.tsx", "utf8")));
    check("Assigned-to-me page still passes agents: [] (deliberately excluded, unchanged)", /agents: \[\]/.test(await fs.readFile("app/(main)/tickets/assigned-to-me/page.tsx", "utf8")));
    const assignedToMeSrc = await fs.readFile("app/(main)/tickets/assigned-to-me/page.tsx", "utf8");
    check("...and its <TicketFilters> call site does not pass showAssigneeFilter as a prop", !/<TicketFilters[^>]*showAssigneeFilter/.test(assignedToMeSrc));

    console.log("\n=== Rejected/Pending (Pending Email) are untouched — no assignedAgentId concept exists there ===\n");
    const rejectedSrc = await fs.readFile("app/(main)/tickets/rejected/page.tsx", "utf8");
    const pendingSrc = await fs.readFile("app/(main)/tickets/pending/page.tsx", "utf8");
    const usesSharedTicketFilters = (src: string) => /from "@\/components\/tickets\/ticket-filters"/.test(src);
    check("Rejected page uses PendingTicketFilters, never imports the shared ticket-filters module", /PendingTicketFilters/.test(rejectedSrc) && !usesSharedTicketFilters(rejectedSrc));
    check("Pending page uses PendingTicketFilters, never imports the shared ticket-filters module", /PendingTicketFilters/.test(pendingSrc) && !usesSharedTicketFilters(pendingSrc));
    check("Neither references assignedAgentId (PendingTicket has no such column)", !/assignedAgentId/.test(rejectedSrc) && !/assignedAgentId/.test(pendingSrc));

    console.log("\n=== 11. /tickets itself still works (no regression from the shared showAssigneeFilter refactor) ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const callAllTickets = callPage(AllTicketsPage, "/tickets");
    const allTicketsNoFilter = await callAllTickets({});
    check("/tickets: TicketFilters still renders with BOTH isAllTickets and showAssigneeFilter", allTicketsNoFilter.filtersProps?.isAllTickets === true && allTicketsNoFilter.filtersProps?.showAssigneeFilter === true);
    const allTicketsByAgentX = await callAllTickets({ assignedAgentId: agentX.id });
    // /tickets' default (non-closed) scope correctly EXCLUDES c1/c4 (both
    // Closed status) — that's the Closed page's own job, not a bug here.
    check("/tickets: assignedAgentId filter still works end to end (finds the non-closed agentX tickets: m1, m4, otherPersonTicket)", [m1.id, m4.id, otherPersonTicket.id].every((id) => allTicketsByAgentX.ids.includes(id)));
    check("...and correctly excludes the CLOSED agentX tickets from this default (non-closed) view", !allTicketsByAgentX.ids.includes(c1.id) && !allTicketsByAgentX.ids.includes(c4.id));
    const allTicketsAllStatuses = await callAllTickets({ assignedAgentId: agentX.id, status: "all" });
    check("...but ?status=all lifts that default and includes them too (same union, not a separate query)", [c1.id, c4.id, m1.id, m4.id, otherPersonTicket.id].every((id) => allTicketsAllStatuses.ids.includes(id)));
    const allTicketsPageSrc = await fs.readFile("app/(main)/tickets/page.tsx", "utf8");
    check("...now sourced from the shared getVisibleTicketAssignees() helper, not a re-inlined query", /getVisibleTicketAssignees\(/.test(allTicketsPageSrc) && !/prisma\.user\.findMany\(\{ where: \{ role: \{ in: \[Role\.IT_AGENT/.test(allTicketsPageSrc));

    console.log("\n=== assigned-to-me itself still renders correctly (untouched surface) ===\n");
    currentSession = { user: { id: agentX.id, role: Role.IT_AGENT, customRoleId: null } };
    const callAssignedToMe = callPage(AssignedToMePage, "/tickets/assigned-to-me");
    const assignedToMeResult = await callAssignedToMe({});
    check("assigned-to-me: still correctly scoped to the viewer's own assignments (m1, m4, c1, c4, otherPersonTicket — all assigned to agentX)", [m1.id, m4.id, c1.id, c4.id, otherPersonTicket.id].every((id) => assignedToMeResult.ids.includes(id)));
    check("...still offers no agent options (agents: [])", assignedToMeResult.agentOptionIds.length === 0);
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
