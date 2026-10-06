/**
 * Regression coverage for the new "Department" column added to the shared
 * components/tickets/ticket-table.tsx — rendered by every Ticket list page
 * (All/Open/Closed/Rejected/Created-by-Me/Assigned-to-Me). Display only:
 * every page already selected `department: { select: { id: true, name:
 * true } }` in its Prisma query (confirmed by audit before implementing),
 * so this required zero new data fetching, zero new query, zero N+1 — the
 * column's value comes straight from the Ticket's own CURRENT department
 * relation, never from the active Workspace, never derived from
 * `departmentChangedBy` (a completely independent, untouched column).
 *
 * Two layers, matching this repo's established conventions:
 *  - Structural (readFileSync on the component source): exact column order,
 *    cell wiring, colSpan, and that departmentChangedBy's own cell is
 *    byte-for-byte untouched.
 *  - Integration (real page Server Components, mocked auth/cookies): the
 *    `department` value actually flowing through to TicketTable's own
 *    `tickets` prop is each Ticket's real, current department — proven
 *    across multiple departments, under "All Workspaces", after a
 *    workspace switch, and for a legacy/null-department row.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-table-department-column.ts
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

// ══════════════ Structural: exact source wiring ══════════════
console.log("\n=== 1, 2, 10, 17. TicketTable source — column order, cell wiring, no new data fetching ===\n");
const tableSource = readFileSync(join(process.cwd(), "components/tickets/ticket-table.tsx"), "utf-8");
const deptHeaderIdx = tableSource.indexOf("<TableHead>Department</TableHead>");
const changedByHeaderIdx = tableSource.indexOf("<TableHead>Dept. changed by</TableHead>");
check("1. A 'Department' TableHead exists", deptHeaderIdx !== -1);
check("2. It appears immediately before 'Dept. changed by' in source order", deptHeaderIdx !== -1 && changedByHeaderIdx !== -1 && deptHeaderIdx < changedByHeaderIdx);
check("3. The cell renders ticket.department?.name with a safe '—' fallback", tableSource.includes("ticket.department?.name ?? ") && tableSource.includes('"—"'));
check("10. departmentChangedBy's own cell logic is byte-for-byte untouched", tableSource.includes("ticket.departmentChangedBy.name ?? ticket.departmentChangedBy.email"));
check("...departmentChangedAt title tooltip is untouched", tableSource.includes("ticket.departmentChangedAt ? formatDateTime(ticket.departmentChangedAt) : undefined"));
check("colSpan updated for the one new column (showRequester true/false)", tableSource.includes("colSpan={showRequester ? 13 : 12}"));
check("17. No new data-fetching call was introduced in the shared table component", !tableSource.includes("fetch("));
check("...Department is never derived from a workspace/active-workspace label anywhere in this file", !/activeWorkspace|workspace\.(name|label)/i.test(tableSource));

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
    console.log("No reachable DATABASE_URL — skipping the integration part.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { default: OpenTicketsPage } = await import("@/app/(main)/tickets/open/page");
  const { default: ClosedTicketsPage } = await import("@/app/(main)/tickets/closed/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  type RowInfo = { id: string; departmentName: string | null; departmentChangedByName?: string | null };
  async function callPage(page: (args: any) => Promise<any>, params: Record<string, string> = {}): Promise<RowInfo[]> {
    try {
      const element = await page({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, TicketTable);
      const tickets = (tableEl?.props.tickets as any[]) ?? [];
      return tickets.map((t) => ({ id: t.id, departmentName: t.department?.name ?? null, departmentChangedByName: t.departmentChangedBy?.name ?? null }));
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) return [];
      throw err;
    }
  }

  try {
    console.log("\n=== 4, 5, 6, 7, 8. Real department values across pages/workspaces (never the active-workspace label) ===\n");
    const deptA = await createDepartment({ name: `TblDept Finance ${RUN_ID}`, slug: `tbldept-finance-${RUN_ID}` });
    const deptB = await createDepartment({ name: `TblDept IT ${RUN_ID}`, slug: `tbldept-it-${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id);

    const openStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Open" } });
    const closedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Closed" } });
    const openStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, name: "Open" } });

    const requester = await prisma.user.create({ data: { email: `tbldept-requester-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    const changer = await prisma.user.create({ data: { email: `tbldept-changer-${RUN_ID}@kinsen.gr`, name: `Changer ${RUN_ID}`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id, changer.id);

    const multiUser = await prisma.user.create({ data: { email: `tbldept-multi-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(multiUser.id);
    for (const dept of [deptA, deptB]) {
      await prisma.departmentMembership.create({
        data: { userId: multiUser.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_ADMIN, source: MembershipSource.MANUAL, isPrimary: dept.id === deptA.id, isActive: true },
      });
    }
    const directorUser = await prisma.user.create({ data: { email: `tbldept-director-${RUN_ID}@kinsen.gr`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(directorUser.id);

    const ticketA = await prisma.ticket.create({
      data: { title: `TblDept A Open ${RUN_ID}`, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptA.id, statusId: openStatusA.id },
    });
    const ticketAClosed = await prisma.ticket.create({
      data: { title: `TblDept A Closed ${RUN_ID}`, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptA.id, statusId: closedStatusA.id },
    });
    const ticketB = await prisma.ticket.create({
      data: { title: `TblDept B Open ${RUN_ID}`, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptB.id, statusId: openStatusB.id },
    });
    // 10, 11. A ticket whose department was REASSIGNED (department != the
    // department departmentChangedBy/departmentChangedAt describe moving it
    // FROM) — proves the two columns are independently sourced, never one
    // derived from the other.
    const ticketMoved = await prisma.ticket.create({
      data: {
        title: `TblDept Moved ${RUN_ID}`,
        description: "seed",
        source: "WEB",
        requesterId: requester.id,
        departmentId: deptB.id,
        statusId: openStatusB.id,
        departmentChangedById: changer.id,
        departmentChangedAt: new Date(),
      },
    });
    ticketIds.push(ticketA.id, ticketAClosed.id, ticketB.id, ticketMoved.id);

    currentSession = { user: { id: directorUser.id, role: Role.DIRECTOR, customRoleId: null } };
    currentCookieValue = ALL_WORKSPACES_VALUE;

    const allRows = await callPage(AllTicketsPage, { status: "all" });
    const rowA = allRows.find((r) => r.id === ticketA.id);
    const rowB = allRows.find((r) => r.id === ticketB.id);
    const rowMoved = allRows.find((r) => r.id === ticketMoved.id);
    check("4/5. All Tickets, All Workspaces: Ticket A shows its OWN department (Finance), not a workspace label", rowA?.departmentName === deptA.name);
    check("5. ...Ticket B shows ITS OWN, different department (IT) in the very same list", rowB?.departmentName === deptB.name);
    check("11. The moved Ticket's Department (current, dept B) is independent of its departmentChangedBy (changer user) — neither derived from the other", rowMoved?.departmentName === deptB.name && rowMoved?.departmentChangedByName === changer.name);

    const openRows = await callPage(OpenTicketsPage, {});
    const openRowA = openRows.find((r) => r.id === ticketA.id);
    check("6. Open Tickets includes the column with the correct real department", openRowA?.departmentName === deptA.name);

    currentCookieValue = deptA.id;
    const closedRows = await callPage(ClosedTicketsPage, { departmentId: deptA.id });
    const closedRowA = closedRows.find((r) => r.id === ticketAClosed.id);
    check("7. Closed Tickets includes the column with the correct real department", closedRowA?.departmentName === deptA.name);

    console.log("\n=== 'All Workspaces' vs switched-Workspace: Department values stay correct either way ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id;
    const scopedRows = await callPage(AllTicketsPage, { status: "all" });
    check("Switched to Workspace A: only A's tickets appear (scoping unchanged)", scopedRows.every((r) => r.id !== ticketB.id));
    check("...and the surviving rows still show department 'Finance', not a workspace label", scopedRows.filter((r) => r.id === ticketA.id || r.id === ticketAClosed.id).every((r) => r.departmentName === deptA.name));

    console.log("\n=== 16. Legacy/null-Department Ticket renders safely (department relation is nullable) ===\n");
    const ticketNoDept = await prisma.ticket.create({
      data: { title: `TblDept NullDept ${RUN_ID}`, description: "seed", source: "WEB", requesterId: requester.id, statusId: openStatusA.id },
    });
    ticketIds.push(ticketNoDept.id);
    currentSession = { user: { id: directorUser.id, role: Role.DIRECTOR, customRoleId: null } };
    currentCookieValue = ALL_WORKSPACES_VALUE;
    const rowsWithNull = await callPage(AllTicketsPage, { status: "all" });
    const nullRow = rowsWithNull.find((r) => r.id === ticketNoDept.id);
    check("A Ticket with no department does not crash the page and resolves to null (renders as '—' in the UI)", nullRow !== undefined && nullRow.departmentName === null);
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
