/**
 * Deterministic reproduction of the exact reported Finance/Open UI scenario,
 * repeated 10 consecutive times with zero tolerance for intermittent
 * failures: Workspace = Finance, Ticket1 = Open, Ticket2 = In Progress.
 *   - No status filter -> both tickets appear.
 *   - Status = Open -> Ticket1 appears (and only Ticket1).
 *   - Status = In Progress -> Ticket2 appears (and only Ticket2).
 *   - Status cleared -> both tickets return.
 * Exercises the REAL app/(main)/tickets/page.tsx Server Component function
 * directly (mocked @/lib/auth + next/headers, same convention as
 * test-ticket-status-filter-determinism.ts) — never a reimplementation.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-status-filter-open-inprogress-repeat10.ts
 */
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
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
const TAG = `oi10-${RUN_ID}`;

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

  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const callList = async (params: Record<string, string>): Promise<{ ids: string[] }> => {
    const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
    const [tableEl] = findElementsByType(element, TicketTable);
    const tickets = (tableEl?.props.tickets as any[]) ?? [];
    return { ids: tickets.map((t) => t.id) };
  };

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixture: Finance-like department, Ticket1=Open, Ticket2=In Progress ===\n");
    const finance = await createDepartment({ name: `${TAG}-Finance`, slug: `${TAG}-finance` });
    departmentIds.push(finance.id);

    const open = await prisma.ticketStatus.findFirst({ where: { departmentId: finance.id, name: "Open" }, select: { id: true } });
    const inProgress = await prisma.ticketStatus.findFirst({ where: { departmentId: finance.id, name: "In Progress" }, select: { id: true } });
    if (!open || !inProgress) throw new Error("Starter Open/In Progress statuses were not seeded for the new department — cannot run.");

    const requester = await prisma.user.create({
      data: { email: `${TAG}-requester@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(requester.id);

    const ticket1 = await prisma.ticket.create({
      data: { title: `${TAG} Ticket1 (Open)`, description: "fixture", departmentId: finance.id, statusId: open.id, requesterId: requester.id },
    });
    const ticket2 = await prisma.ticket.create({
      data: { title: `${TAG} Ticket2 (In Progress)`, description: "fixture", departmentId: finance.id, statusId: inProgress.id, requesterId: requester.id },
    });
    ticketIds.push(ticket1.id, ticket2.id);

    currentSession = { user: { id: requester.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = finance.id;

    console.log("\n=== Running the full No-filter -> Open -> In Progress -> Clear cycle 10 consecutive times ===\n");
    for (let i = 1; i <= 10; i++) {
      const noFilter = await callList({});
      check(`[${i}/10] No filter includes Ticket1 (Open)`, noFilter.ids.includes(ticket1.id));
      check(`[${i}/10] No filter includes Ticket2 (In Progress)`, noFilter.ids.includes(ticket2.id));

      const openFilter = await callList({ statusId: open.id });
      check(`[${i}/10] Status=Open returns EXACTLY Ticket1`, openFilter.ids.join(",") === ticket1.id, openFilter.ids.join(","));

      const inProgressFilter = await callList({ statusId: inProgress.id });
      check(`[${i}/10] Status=In Progress returns EXACTLY Ticket2`, inProgressFilter.ids.join(",") === ticket2.id, inProgressFilter.ids.join(","));

      const cleared = await callList({});
      check(`[${i}/10] Clearing the filter returns both tickets again`, cleared.ids.includes(ticket1.id) && cleared.ids.includes(ticket2.id));
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
