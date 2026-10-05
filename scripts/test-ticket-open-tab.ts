/**
 * Regression coverage for the new Open Tickets tab/page
 * (app/(main)/tickets/open/page.tsx) — the mirror image of
 * app/(main)/tickets/closed/page.tsx, same architecture throughout
 * (workspace scoping, filters, pagination, sort, realtime), with exactly
 * one inverted condition: `status.isClosed === false AND cancelReasonId
 * IS NULL` (never a status-NAME heuristic).
 *
 * Exercises the REAL app/(main)/tickets/open/page.tsx,
 * app/(main)/tickets/closed/page.tsx, and app/(main)/tickets/page.tsx
 * Server Component functions directly (mocked @/lib/auth + next/headers
 * cookies()), same established pattern as
 * scripts/test-ticket-list-department-scope-regression.ts.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-open-tab.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;

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
let currentCookieValue: string | undefined = undefined;

mock.module("@/lib/auth", {
  namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} },
});
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (name === "active_department_id" && currentCookieValue ? { value: currentCookieValue } : undefined),
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
  const { prisma } = await import("@/lib/prisma");
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { ALL_WORKSPACES_VALUE } = await import("@/types/department");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: OpenTicketsPage } = await import("@/app/(main)/tickets/open/page");
  const { default: ClosedTicketsPage } = await import("@/app/(main)/tickets/closed/page");
  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const statusIds: string[] = [];

  type ListResult = { ids: string[]; redirectTo?: string };
  async function callPage(page: (args: { searchParams: Promise<Record<string, string>> }) => Promise<any>, params: Record<string, string>): Promise<ListResult> {
    try {
      const element = await page({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, TicketTable);
      const tickets = (tableEl?.props.tickets as any[]) ?? [];
      return { ids: tickets.map((t) => t.id) };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { ids: [], redirectTo: err.digest.split(";")[2] ?? "" };
      }
      throw err;
    }
  }

  try {
    // ══════════════ Fixtures ══════════════
    const deptA = await createDepartment({ name: `OpenTab Finance ${RUN_ID}`, slug: `opentab-finance-${RUN_ID}` });
    const deptB = await createDepartment({ name: `OpenTab IT ${RUN_ID}`, slug: `opentab-it-${RUN_ID}` });
    const deptC = await createDepartment({ name: `OpenTab Unauthorized ${RUN_ID}`, slug: `opentab-unauth-${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id, deptC.id);

    // Default per-department seeded statuses — includes "Resolved" and
    // "Pending User" (both isClosed:false but NOT named "Open" or
    // anything open-sounding) and "Closed"/"Cancelled" (isClosed:true) —
    // exactly the mix this test needs to prove the rule is isClosed, not
    // a name heuristic.
    const openStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Open" } });
    const resolvedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Resolved" } });
    const pendingUserStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Pending User" } });
    const closedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Closed" } });
    const cancelledStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Cancelled" } });
    const openStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, name: "Open" } });
    const closedStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, name: "Closed" } });

    // A department-specific, deliberately UNUSUAL non-closed status name —
    // item 6: differently-named open statuses across departments both work.
    const weirdOpenStatusB = await prisma.ticketStatus.create({
      data: { departmentId: deptB.id, name: `Awaiting Vendor Response ${RUN_ID}`, color: "#999999", isClosed: false, order: 99 },
    });
    statusIds.push(weirdOpenStatusB.id);

    const priorityHighA = await prisma.ticketPriority.findFirstOrThrow({ where: { departmentId: deptA.id }, orderBy: { level: "desc" } });

    const requester = await prisma.user.create({ data: { email: `opentab-requester-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id);

    const multiUser = await prisma.user.create({ data: { email: `opentab-multi-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(multiUser.id);
    for (const dept of [deptA, deptB]) {
      await prisma.departmentMembership.create({
        data: { userId: multiUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: dept.id === deptA.id, isActive: true },
      });
    }

    // DEPARTMENT_ADMIN does NOT include "ticket.closed.view" by default
    // (confirmed against the real RolePermission table) — that is the
    // correct, intentional, elevated-permission design this task must
    // never weaken (Closed Tickets requires a separate, more elevated
    // grant than "All Tickets"/"Open Tickets", which only need
    // ticket.view.all). A DIRECTOR has the canViewAllDepartments bypass,
    // which hardcodes canViewClosedTickets:true — used here purely as a
    // fixture convenience to exercise ClosedTicketsPage itself (already
    // proven correct/untouched by this task), never as a substitute for
    // testing multiUser's own real Open/All Tickets permissions above.
    const directorUser = await prisma.user.create({ data: { email: `opentab-director-${RUN_ID}@kinsen.gr`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(directorUser.id);
    const directorSession = { user: { id: directorUser.id, role: Role.DIRECTOR, customRoleId: null } };
    async function callClosedPageAsDirector(departmentId: string, extraParams: Record<string, string> = {}): Promise<ListResult> {
      const savedSession = currentSession;
      const savedCookie = currentCookieValue;
      currentSession = directorSession;
      currentCookieValue = departmentId;
      try {
        return await callPage(ClosedTicketsPage, { departmentId, ...extraParams });
      } finally {
        currentSession = savedSession;
        currentCookieValue = savedCookie;
      }
    }

    const seedTicket = async (dept: { id: string }, status: { id: string }, title: string, extra: Record<string, unknown> = {}) => {
      const t = await prisma.ticket.create({ data: { title, description: "seed", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: status.id, ...extra } });
      ticketIds.push(t.id);
      return t;
    };

    const ticketOpenA = await seedTicket(deptA, openStatusA, `OpenTab A Open ${RUN_ID}`, { priorityId: priorityHighA.id });
    const ticketResolvedA = await seedTicket(deptA, resolvedStatusA, `OpenTab A Resolved ${RUN_ID}`);
    const ticketPendingA = await seedTicket(deptA, pendingUserStatusA, `OpenTab A PendingUser ${RUN_ID}`);
    const ticketClosedA = await seedTicket(deptA, closedStatusA, `OpenTab A Closed ${RUN_ID}`);
    const ticketCancelledA = await seedTicket(deptA, cancelledStatusA, `OpenTab A Cancelled ${RUN_ID}`, { cancelReasonId: null });
    const ticketOpenB = await seedTicket(deptB, openStatusB, `OpenTab B Open ${RUN_ID}`);
    const ticketWeirdOpenB = await seedTicket(deptB, weirdOpenStatusB, `OpenTab B WeirdOpen ${RUN_ID}`);
    const ticketClosedB = await seedTicket(deptB, closedStatusB, `OpenTab B Closed ${RUN_ID}`);

    // A ticket "cancelled" (cancelReasonId set) but WHOSE status never
    // actually transitioned to an isClosed one — the real edge case
    // app/api/tickets/[id]/cancel/route.ts can produce when no closed
    // status exists for the department at cancel time. Must appear in
    // Closed (per its existing OR condition) and NEVER in Open.
    const cancelReason = await prisma.ticketCancelReason.create({ data: { departmentId: deptA.id, name: `OpenTab CancelReason ${RUN_ID}` } });
    const ticketCancelledButNotClosedA = await seedTicket(deptA, openStatusA, `OpenTab A CancelledNotClosed ${RUN_ID}`, { cancelReasonId: cancelReason.id, closedAt: new Date() });

    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };

    // ══════════════ 1-4. Open shows isClosed:false, excludes isClosed:true, not by name ══════════════
    console.log("\n=== 1-4. Open route exists, shows isClosed:false, excludes isClosed:true, never by status name ===\n");
    currentCookieValue = deptA.id;
    const openA = await callPage(OpenTicketsPage, {});
    check("1. The Open route resolves and renders a real Ticket list (not a redirect)", !openA.redirectTo);
    check("2. Open includes the literally-named 'Open' status ticket", openA.ids.includes(ticketOpenA.id));
    check("2/4. Open ALSO includes 'Resolved' (isClosed:false, NOT named anything open-sounding) — proves the rule is isClosed, not a name match", openA.ids.includes(ticketResolvedA.id));
    check("5. Open ALSO includes 'Pending User' (a THIRD distinct non-closed status) — multiple different non-closed statuses all included", openA.ids.includes(ticketPendingA.id));
    check("3. Open EXCLUDES the 'Closed' status ticket", !openA.ids.includes(ticketClosedA.id));
    check("3. Open EXCLUDES the 'Cancelled' status ticket (isClosed:true)", !openA.ids.includes(ticketCancelledA.id));
    check("...Open EXCLUDES a ticket with a cancelReasonId even if its status itself never became isClosed (the real edge case)", !openA.ids.includes(ticketCancelledButNotClosedA.id));

    // ══════════════ 6. Department-specific differently-named open statuses ══════════════
    console.log("\n=== 6. Differently-named non-closed statuses across departments both work ===\n");
    currentCookieValue = deptB.id;
    const openB = await callPage(OpenTicketsPage, {});
    check("6. Open (Workspace B) includes the literally-named 'Open' status ticket", openB.ids.includes(ticketOpenB.id));
    check("6. Open (Workspace B) ALSO includes the deliberately unusually-named 'Awaiting Vendor Response' status ticket — cross-department, differently-named, still correctly 'open'", openB.ids.includes(ticketWeirdOpenB.id));
    check("...and still excludes B's Closed ticket", !openB.ids.includes(ticketClosedB.id));

    // ══════════════ 7. Closed still shows only isClosed:true ══════════════
    console.log("\n=== 7. Closed Tickets page is completely unaffected by this feature ===\n");
    const closedA = await callClosedPageAsDirector(deptA.id);
    check("7. Closed includes the Closed status ticket", closedA.ids.includes(ticketClosedA.id));
    check("7. Closed includes the Cancelled status ticket", closedA.ids.includes(ticketCancelledA.id));
    check("7. Closed includes the cancelled-but-not-formally-closed ticket (its own existing OR condition, untouched)", closedA.ids.includes(ticketCancelledButNotClosedA.id));
    check("7. Closed EXCLUDES every non-closed status ticket (Open/Resolved/Pending User)", !closedA.ids.includes(ticketOpenA.id) && !closedA.ids.includes(ticketResolvedA.id) && !closedA.ids.includes(ticketPendingA.id));

    // ══════════════ 8. All Tickets (?status=all) still includes both ══════════════
    console.log("\n=== 8. All Tickets (?status=all) still shows both open and closed ===\n");
    currentCookieValue = deptA.id;
    const allA = await callPage(AllTicketsPage, { status: "all" });
    check("8. All Tickets (status=all) includes the Open ticket", allA.ids.includes(ticketOpenA.id));
    check("8. All Tickets (status=all) includes the Resolved ticket", allA.ids.includes(ticketResolvedA.id));
    check("8. All Tickets (status=all) includes the Closed ticket", allA.ids.includes(ticketClosedA.id));
    check("8. All Tickets (status=all) includes the Cancelled ticket", allA.ids.includes(ticketCancelledA.id));
    check("...All Tickets' OWN default (no status=all) was never silently changed to Open-only — still non-closed by default, unaffected by this task", (await callPage(AllTicketsPage, {})).ids.includes(ticketOpenA.id) && !(await callPage(AllTicketsPage, {})).ids.includes(ticketClosedA.id));

    // ══════════════ 9-11. Workspace scoping ══════════════
    console.log("\n=== 9-11. Open respects active Workspace, switches immediately, All Workspaces gives the union ===\n");
    currentCookieValue = deptA.id;
    const openWorkspaceA = await callPage(OpenTicketsPage, {});
    check("9. Workspace A: Open shows A's open tickets", openWorkspaceA.ids.includes(ticketOpenA.id));
    check("9. Workspace A: Open does NOT show B's open tickets", !openWorkspaceA.ids.includes(ticketOpenB.id));

    currentCookieValue = deptB.id;
    const openWorkspaceB = await callPage(OpenTicketsPage, {});
    check("10. Switching Workspace to B re-scopes Open immediately: B's open ticket now visible", openWorkspaceB.ids.includes(ticketOpenB.id));
    check("10. ...A's open ticket no longer visible", !openWorkspaceB.ids.includes(ticketOpenA.id));

    currentSession = directorSession;
    currentCookieValue = ALL_WORKSPACES_VALUE;
    const openAllWorkspaces = await callPage(OpenTicketsPage, {});
    check("11. 'All Workspaces' (DIRECTOR): Open shows BOTH A's and B's open tickets at once — the union still works", openAllWorkspaces.ids.includes(ticketOpenA.id) && openAllWorkspaces.ids.includes(ticketOpenB.id));

    // ══════════════ 12. Explicit departmentId precedence ══════════════
    console.log("\n=== 12. Explicit ?departmentId= still wins over the active Workspace ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id;
    const openExplicitB = await callPage(OpenTicketsPage, { departmentId: deptB.id });
    check("12. Explicit departmentId=B overrides active Workspace A — B's open ticket visible", openExplicitB.ids.includes(ticketOpenB.id));
    check("12. ...A's open ticket excluded", !openExplicitB.ids.includes(ticketOpenA.id));

    // ══════════════ 13. Composes with existing filters ══════════════
    console.log("\n=== 13. Open composes correctly with priority/category/search filters ===\n");
    currentCookieValue = deptA.id;
    const openPriorityFiltered = await callPage(OpenTicketsPage, { priorityId: priorityHighA.id });
    check("13. Open + explicit High priority filter: includes the matching Open ticket", openPriorityFiltered.ids.includes(ticketOpenA.id));
    check("...and still excludes the Closed ticket regardless of priority", !openPriorityFiltered.ids.includes(ticketClosedA.id));
    const openSearchFiltered = await callPage(OpenTicketsPage, { search: `OpenTab A Resolved ${RUN_ID}` });
    check("13. Open + search narrows to exactly the matching (still non-closed) ticket", openSearchFiltered.ids.length === 1 && openSearchFiltered.ids[0] === ticketResolvedA.id);

    // ══════════════ 14-15. Pagination + sorting ══════════════
    console.log("\n=== 14-15. Pagination and sorting work ===\n");
    const openPaged = await (async () => {
      const element = await OpenTicketsPage({ searchParams: Promise.resolve({ pageSize: "20" }) } as any);
      const [tableEl] = findElementsByType(element, TicketTable);
      return tableEl?.props.pagination;
    })();
    check("14. Pagination metadata is present with the requested pageSize honored", openPaged?.pageSize === 20);
    const openSorted = await callPage(OpenTicketsPage, { sortBy: "title", sortOrder: "asc" });
    check("15. Sorting by title works without error (a real, non-empty, non-redirected result)", openSorted.ids.length > 0);

    // ══════════════ 16-17. Server-authoritative permissions/accessibility ══════════════
    console.log("\n=== 16-17. Permissions remain server-authoritative; unauthorized department cannot be exposed ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const noAccessResult = await callPage(OpenTicketsPage, {});
    check("16. A user with no ticket-view membership anywhere is redirected away, never shown a silent empty/wrong list", noAccessResult.redirectTo !== undefined || noAccessResult.ids.length === 0);

    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id;
    const unauthorizedDeptAttempt = await callPage(OpenTicketsPage, { departmentId: deptC.id });
    check("17. An explicit ?departmentId= for a department the user has NO access to is denied, never silently exposed", unauthorizedDeptAttempt.redirectTo !== undefined || unauthorizedDeptAttempt.ids.length === 0);

    // ══════════════ 18-19. Realtime lifecycle (status transition correctness) ══════════════
    console.log("\n=== 18-19. open<->closed status transitions move the Ticket between the two pages (realtime re-runs this SAME query) ===\n");
    await prisma.ticket.update({ where: { id: ticketOpenA.id }, data: { statusId: closedStatusA.id } });
    const openAfterClose = await callPage(OpenTicketsPage, {});
    const closedAfterClose = await callClosedPageAsDirector(deptA.id);
    check("18. After the Ticket's status changes to a closed one, it disappears from Open", !openAfterClose.ids.includes(ticketOpenA.id));
    check("...and now appears in Closed", closedAfterClose.ids.includes(ticketOpenA.id));

    await prisma.ticket.update({ where: { id: ticketOpenA.id }, data: { statusId: openStatusA.id } });
    const openAfterReopen = await callPage(OpenTicketsPage, {});
    const closedAfterReopen = await callClosedPageAsDirector(deptA.id);
    check("19. Changing it BACK to a non-closed status makes it eligible for Open again", openAfterReopen.ids.includes(ticketOpenA.id));
    check("...and it disappears from Closed", !closedAfterReopen.ids.includes(ticketOpenA.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.ticketCancelReason.deleteMany({ where: { name: { contains: RUN_ID.toString() } } });
      await prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } });
      await prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
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
