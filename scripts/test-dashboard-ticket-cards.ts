/**
 * Verifies the Tickets Dashboard's clickable KPI cards: each card's `href`
 * query contract (?status=all|open|in_progress|closed, ?source=EMAIL) must
 * produce a ticket-list result count IDENTICAL to the dashboard's own count
 * for that same card — both paths share lib/services/ticket-status-groups.ts,
 * this test proves that sharing actually holds end to end (real dashboard
 * count query + the real All Tickets page function, not reimplementations
 * of either).
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

    const callList = async (params: Record<string, string>) => {
      const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, TicketTable);
      return { total: tableEl?.props.total as number, ids: (tableEl?.props.tickets as any[])?.map((t) => t.id) ?? [] };
    };

    const groups: { group: TicketStatusGroup; expectedIds: string[] }[] = [
      { group: "all", expectedIds: [t1.id, t2.id, t3.id, t4.id] },
      { group: "open", expectedIds: [t1.id, t2.id, t4.id] },
      { group: "in_progress", expectedIds: [t2.id] },
      { group: "closed", expectedIds: [t3.id] },
    ];

    for (const { group, expectedIds } of groups) {
      console.log(`\nGroup "${group}"...\n`);
      const dashboardCount = await prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition(group) } });
      check(`Dashboard count for "${group}" matches the expected fixture count (${expectedIds.length})`, dashboardCount === expectedIds.length);

      const listResult = await callList(group === "open" ? {} : { status: group });
      check(`List result for "${group}" has the same total as the dashboard count`, listResult.total === dashboardCount);
      check(`List result for "${group}" contains exactly the expected tickets`, listResult.ids.slice().sort().join(",") === expectedIds.slice().sort().join(","));
    }

    console.log("\nSource = EMAIL...\n");
    const dashboardEmailCount = await prisma.ticket.count({ where: { ...ticketWhere, source: "EMAIL" } });
    check("Dashboard email-source count matches the expected fixture count (1)", dashboardEmailCount === 1);
    const emailListResult = await callList({ source: "EMAIL" });
    check("List result for source=EMAIL has the same total as the dashboard count", emailListResult.total === dashboardEmailCount);
    check("List result for source=EMAIL contains exactly t4", emailListResult.ids.join(",") === t4.id);

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
    check("Closed card links to ?status=closed", kpiCardsSource.includes('href: "/tickets?status=closed"'));
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
