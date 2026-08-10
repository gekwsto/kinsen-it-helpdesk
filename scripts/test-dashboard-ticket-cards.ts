/**
 * Verifies the Tickets Dashboard's clickable KPI cards against the CURRENT
 * (post status-group-dropdown-removal) contract of app/(main)/tickets/page.tsx:
 *
 *  - "all" (Total Tickets card): still produces an exact parity match with
 *    the Dashboard's own count — lifts the default non-closed scope so
 *    closed-status tickets are included too.
 *  - absent / "open" (Open card): still produces an exact parity match —
 *    the page's own implicit default (isClosed:false) is identical to what
 *    the old "open" group used to mean.
 *  - "closed" (Closed card): no longer filters the All Tickets list at
 *    all — it now REDIRECTS to the dedicated /tickets/closed page (the
 *    actual fix for the Finance/"In Progress" bug: closed scoping and a
 *    specific statusId selection used to be two independently-computed
 *    conditions that could silently contradict each other and zero out a
 *    real match; there is now exactly one page for "closed").
 *  - "in_progress" (In Progress card): the OLD name-heuristic AND-condition
 *    that used to narrow the list to just name-contains-"Progress" tickets
 *    is retired (it was the other half of the same contradiction risk).
 *    The Dashboard's own KPI COUNT for this card is unaffected (still the
 *    exact same lib/services/ticket-status-groups.ts query), but clicking
 *    through now intentionally lands on the same default non-closed view
 *    as "Open" rather than a further-narrowed subset — a deliberate,
 *    disclosed decoupling, not a bug.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-dashboard-ticket-cards.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";
import { buildTicketStatusGroupCondition, type TicketStatusGroup } from "@/lib/services/ticket-status-groups";

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

  // Dynamically imported (never a static top-level import in this file) so
  // that mock.module("next/headers", ...) above has already registered
  // before department-scope-service.ts's own transitive import of
  // lib/services/workspace-service.ts (which calls next/headers's cookies())
  // is first resolved — a static import here would load the real,
  // unmocked cookies() first and lock that binding in for every later
  // importer sharing the module cache, including the dynamically-imported
  // page below.
  const { buildTicketListWhere } = await import("@/lib/services/department-scope-service");
  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const statusIds: string[] = [];
  const priorityIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `Dash Ticket Cards Dept ${RUN_ID}`, slug: `dash-ticket-cards-dept-${RUN_ID}` });
    departmentIds.push(dept.id);
    // createDepartment() now also creates its own starter TicketStatus set
    // (STARTER_STATUSES: Open/In Progress/Pending User/Resolved/Closed/
    // Cancelled) — cleared here so this test's own three custom-semantics
    // statuses below (in particular "Resolved" deliberately marked
    // isClosed:true, unlike the starter one) can be created under the same
    // names without colliding with @@unique([departmentId, name]).
    await prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } });

    const openStatus = await prisma.ticketStatus.create({ data: { name: "Open", color: "#3b82f6", departmentId: dept.id, isClosed: false, isDefault: true, order: 1 } });
    statusIds.push(openStatus.id);
    const inProgressStatus = await prisma.ticketStatus.create({ data: { name: "In Progress", color: "#f59e0b", departmentId: dept.id, isClosed: false, order: 2 } });
    statusIds.push(inProgressStatus.id);
    // Deliberately named "Resolved" (not containing "Progress") — proves the
    // "closed" group is defined by isClosed, never by name matching.
    const closedStatus = await prisma.ticketStatus.create({ data: { name: "Resolved", color: "#10b981", departmentId: dept.id, isClosed: true, order: 3 } });
    statusIds.push(closedStatus.id);

    const priority = await prisma.ticketPriority.create({ data: { name: `Dash Test Priority ${RUN_ID}`, color: "#888", level: 1, departmentId: dept.id } });
    priorityIds.push(priority.id);

    const requester = await prisma.user.create({ data: { email: `dash-ticket-requester-${RUN_ID}@example.com`, authProvider: AuthProvider.CREDENTIALS, role: Role.USER, departmentId: dept.id } });
    userIds.push(requester.id);
    const adminUser = await prisma.user.create({ data: { email: `dash-ticket-admin-${RUN_ID}@example.com`, authProvider: AuthProvider.CREDENTIALS, role: Role.ADMIN } });
    userIds.push(adminUser.id);

    const mkTicket = (statusId: string, source: "WEB" | "EMAIL") =>
      prisma.ticket.create({
        data: {
          title: `Dash Test Ticket ${RUN_ID} ${statusId}-${source}-${Math.random()}`,
          description: "fixture",
          departmentId: dept.id,
          requesterId: requester.id,
          statusId,
          priorityId: priority.id,
          source: source as any,
        },
      });

    const t1 = await mkTicket(openStatus.id, "WEB");
    const t2 = await mkTicket(inProgressStatus.id, "WEB");
    const t3 = await mkTicket(closedStatus.id, "WEB");
    const t4 = await mkTicket(openStatus.id, "EMAIL");
    ticketIds.push(t1.id, t2.id, t3.id, t4.id);

    currentSession = { user: { id: adminUser.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = dept.id;

    const ticketScope = await buildTicketListWhere(adminUser.id, Role.ADMIN, dept.id);
    const ticketWhere = "denied" in ticketScope ? { id: { in: [] as string[] } } : ticketScope;

    const callList = async (params: Record<string, string>): Promise<{ total: number; ids: string[] } | { redirectTo: string }> => {
      try {
        const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
        const [tableEl] = findElementsByType(element, TicketTable);
        return { total: tableEl?.props.total as number, ids: (tableEl?.props.tickets as any[])?.map((t) => t.id) ?? [] };
      } catch (err: any) {
        if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
          return { redirectTo: err.digest.split(";")[2] ?? "" };
        }
        throw err;
      }
    };

    // "all" and absent/"open" still guarantee exact Dashboard-count/List-result
    // parity — both are still real, single, unambiguous scope decisions.
    const parityGroups: { group: Extract<TicketStatusGroup, "all" | "open">; expectedIds: string[] }[] = [
      { group: "all", expectedIds: [t1.id, t2.id, t3.id, t4.id] },
      { group: "open", expectedIds: [t1.id, t2.id, t4.id] },
    ];
    for (const { group, expectedIds } of parityGroups) {
      console.log(`\nGroup "${group}"...\n`);
      const dashboardCount = await prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition(group) } });
      check(`Dashboard count for "${group}" matches the expected fixture count (${expectedIds.length})`, dashboardCount === expectedIds.length);

      const listResult = await callList(group === "open" ? {} : { status: group });
      if (!("total" in listResult)) { check(`List result for "${group}" did not unexpectedly redirect`, false); continue; }
      check(`List result for "${group}" has the same total as the dashboard count`, listResult.total === dashboardCount);
      check(`List result for "${group}" contains exactly the expected tickets`, listResult.ids.slice().sort().join(",") === expectedIds.slice().sort().join(","));
    }

    console.log("\nGroup \"closed\" — the list page no longer filters, it redirects to the dedicated Closed Tickets page...\n");
    const closedDashboardCount = await prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition("closed") } });
    check("Dashboard count for \"closed\" matches the expected fixture count (1)", closedDashboardCount === 1);
    const closedListResult = await callList({ status: "closed" });
    check("?status=closed on All Tickets redirects (never silently returns an empty/wrong scope)", "redirectTo" in closedListResult);
    if ("redirectTo" in closedListResult) {
      check("...specifically to /tickets/closed (the actual canonical closed-tickets page)", closedListResult.redirectTo.startsWith("/tickets/closed"));
    }

    console.log("\nGroup \"in_progress\" — Dashboard's own KPI count is unaffected; the List page's old name-heuristic AND-condition is retired...\n");
    const inProgressDashboardCount = await prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition("in_progress") } });
    check("Dashboard count for \"in_progress\" still matches the expected fixture count (1) — its own KPI query is untouched", inProgressDashboardCount === 1);
    const inProgressListResult = await callList({ status: "in_progress" });
    if (!("total" in inProgressListResult)) {
      check("?status=in_progress on All Tickets does not redirect", false);
    } else {
      // Deliberately NOT asserting parity with inProgressDashboardCount here —
      // that parity is exactly the old, retired, contradiction-prone
      // mechanism. The list now intentionally shows the same default
      // non-closed view "Open" does (t1, t2, t4), proving the retirement is
      // a coherent, disclosed simplification rather than an error/empty result.
      check(
        "?status=in_progress now shows the same default non-closed view as the absent/\"open\" case (t1, t2, t4) — not a narrower, potentially-contradicting subset",
        inProgressListResult.ids.slice().sort().join(",") === [t1.id, t2.id, t4.id].slice().sort().join(",")
      );
    }

    console.log("\nSource = EMAIL...\n");
    const dashboardEmailCount = await prisma.ticket.count({ where: { ...ticketWhere, source: "EMAIL" } });
    check("Dashboard email-source count matches the expected fixture count (1)", dashboardEmailCount === 1);
    const emailListResult = await callList({ source: "EMAIL" });
    if (!("total" in emailListResult)) {
      check("List result for source=EMAIL did not unexpectedly redirect", false);
    } else {
      check("List result for source=EMAIL has the same total as the dashboard count", emailListResult.total === dashboardEmailCount);
      check("List result for source=EMAIL contains exactly t4", emailListResult.ids.join(",") === t4.id);
    }

    console.log("\nKeyboard accessibility of the KPI cards (structural check)...\n");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const kpiCardsSource = readFileSync(join(process.cwd(), "components/dashboard/kpi-cards.tsx"), "utf-8");
    check("Each card is wrapped in a next/link <Link> (a real, natively keyboard-focusable/Enter-activatable anchor)", kpiCardsSource.includes('<Link\n') || kpiCardsSource.includes("<Link "));
    check("Each card link has a descriptive aria-label", kpiCardsSource.includes("aria-label={card.ariaLabel}"));
    check("Each card link has a visible focus-visible ring (not just a mouse hover state)", kpiCardsSource.includes("focus-visible:ring-2"));
    check("Total Tickets card links to ?status=all", kpiCardsSource.includes('href: "/tickets?status=all"'));
    check("Open card links to ?status=open", kpiCardsSource.includes('href: "/tickets?status=open"'));
    check("In Progress card links to ?status=in_progress", kpiCardsSource.includes('href: "/tickets?status=in_progress"'));
    check("Closed card links directly to the dedicated /tickets/closed page", kpiCardsSource.includes('href: "/tickets/closed"'));
    check("From Email card links to ?source=EMAIL", kpiCardsSource.includes('href: "/tickets?source=EMAIL"'));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      // By departmentId, not just priorityIds — createDepartment() also
      // seeds its own starter TicketPriority rows (RESTRICT FK), not just
      // the one this fixture explicitly created.
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
