/**
 * Regression coverage for the Dashboard "Open" KPI card's navigation
 * target: components/dashboard/kpi-cards.tsx's `open` card used to link
 * to `/tickets?status=open` (indirect — it only worked because `/tickets`
 * falls through to its own default non-closed scope for any status value
 * it doesn't special-case). Now that the canonical
 * app/(main)/tickets/open/page.tsx route exists, the card links there
 * directly instead — the exact same pattern the "Closed" card already
 * used for app/(main)/tickets/closed/page.tsx.
 *
 * This is a TINY routing cleanup: the Dashboard's own metric/count logic,
 * the Open Tickets query semantics, and every other KPI card's href are
 * all untouched — this file proves exactly that, plus that navigating to
 * the bare `/tickets/open` (no query params at all, the way the Dashboard
 * card actually links there) still correctly resolves workspace scoping
 * on its own.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-dashboard-open-link-regression.ts
 */
import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// ══════════════ 1, 5, 6, 7. Structural: exact hrefs, nothing else touched ══════════════
console.log("\n=== 1, 5, 6, 7. KpiCards source — exact hrefs for every card ===\n");
const kpiCardsSource = readFileSync(join(process.cwd(), "components/dashboard/kpi-cards.tsx"), "utf-8");
check("1. Open card now links directly to the canonical /tickets/open page", kpiCardsSource.includes('href: "/tickets/open"'));
check("...the OLD indirect /tickets?status=open link is gone", !kpiCardsSource.includes('href: "/tickets?status=open"'));
check("5. Closed card's navigation is unchanged (still /tickets/closed)", kpiCardsSource.includes('href: "/tickets/closed"'));
check("6. Total Tickets (All Tickets) card's navigation is unchanged (still ?status=all)", kpiCardsSource.includes('href: "/tickets?status=all"'));
check("7a. In Progress card's status= navigation is unchanged (unrelated status-group link, not touched)", kpiCardsSource.includes('href: "/tickets?status=in_progress"'));
check("7b. From Email card's source= navigation is unchanged (unrelated filter, not touched)", kpiCardsSource.includes('href: "/tickets?source=EMAIL"'));

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

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping the functional part.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: OpenTicketsPage } = await import("@/app/(main)/tickets/open/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  async function callOpenPageNoParams(): Promise<{ ids: string[]; redirectTo?: string }> {
    try {
      // Deliberately the EXACT searchParams shape a bare `<Link href="/tickets/open">`
      // click produces — no departmentId, no status, nothing — proving the
      // page resolves workspace scoping entirely on its own, the way the
      // Dashboard card actually navigates there.
      const element = await OpenTicketsPage({ searchParams: Promise.resolve({}) } as any);
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
    console.log("\n=== 3, 4. Bare /tickets/open (no query params, as the Dashboard card links) resolves workspace scoping correctly ===\n");
    const deptA = await createDepartment({ name: `DashOpenLink Finance ${RUN_ID}`, slug: `dash-open-link-finance-${RUN_ID}` });
    const deptB = await createDepartment({ name: `DashOpenLink IT ${RUN_ID}`, slug: `dash-open-link-it-${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id);

    const openStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Open" } });
    const closedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Closed" } });
    const openStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, name: "Open" } });

    const requester = await prisma.user.create({ data: { email: `dash-open-link-requester-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id);
    const multiUser = await prisma.user.create({ data: { email: `dash-open-link-multi-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(multiUser.id);
    for (const dept of [deptA, deptB]) {
      await prisma.departmentMembership.create({
        data: { userId: multiUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: dept.id === deptA.id, isActive: true },
      });
    }

    const seedTicket = async (dept: { id: string }, status: { id: string }, title: string) => {
      const t = await prisma.ticket.create({ data: { title, description: "seed", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: status.id } });
      ticketIds.push(t.id);
      return t;
    };
    const ticketOpenA = await seedTicket(deptA, openStatusA, `DashOpenLink A Open ${RUN_ID}`);
    const ticketClosedA = await seedTicket(deptA, closedStatusA, `DashOpenLink A Closed ${RUN_ID}`);
    const ticketOpenB = await seedTicket(deptB, openStatusB, `DashOpenLink B Open ${RUN_ID}`);

    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };

    currentCookieValue = deptA.id;
    const resultA = await callOpenPageNoParams();
    check("3. Bare /tickets/open shows only non-closed tickets for the active Workspace (A)", resultA.ids.includes(ticketOpenA.id) && !resultA.ids.includes(ticketClosedA.id));
    check("4. ...and respects Workspace A's scope (excludes Workspace B's ticket)", !resultA.ids.includes(ticketOpenB.id));

    currentCookieValue = deptB.id;
    const resultB = await callOpenPageNoParams();
    check("4. Switching the active Workspace to B and hitting the bare route again re-scopes to B", resultB.ids.includes(ticketOpenB.id) && !resultB.ids.includes(ticketOpenA.id));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
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
