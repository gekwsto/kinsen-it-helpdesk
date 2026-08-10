/**
 * Deterministic reproduction + regression coverage for the reported bug:
 * "Finance + In Progress sometimes returns zero tickets even though a
 * matching Finance ticket visibly exists, and the result changes depending
 * on the sequence of workspace/filter interactions."
 *
 * Root cause (see app/(main)/tickets/page.tsx): the page used to AND two
 * INDEPENDENTLY-computed "which statuses are in scope" conditions together
 * — a coarse status-GROUP heuristic (?status=open/in_progress/closed/all,
 * driven by the old left-most "Open" dropdown, defaulting to "open" ->
 * `{status:{isClosed:false}}`, or a name-CONTAINS-"Progress" heuristic for
 * "in_progress") and the precise, explicitly-selected `statusId`. Whenever
 * the group value drifted out of sync with what the real statusId
 * selection actually was (e.g. the group was left on "closed" from an
 * earlier interaction, or a department's real status name didn't literally
 * contain "Progress"), the two ANDed conditions could contradict and
 * silently zero out a real match — exactly the intermittent, sequence-
 * dependent symptom reported.
 *
 * The fix removes the coarse group dropdown/mechanism entirely and makes
 * the "non-closed by default" scope IMPLICIT: the Status dropdown's own
 * option list is scoped to isClosed:false (mirroring what the Closed
 * Tickets page already does for isClosed:true), and the base Prisma
 * condition is derived from that exact same source — so whatever statusId
 * a user actually selects can never contradict the base scope, by
 * construction, not by hoping two independent computations agree.
 *
 * This script exercises the REAL app/(main)/tickets/page.tsx Server
 * Component function directly (mocked @/lib/auth + next/headers, same
 * convention as scripts/test-dashboard-ticket-cards.ts) — never a
 * reimplementation — and repeats the exact selection/workspace-switch
 * sequence many times to prove the result is deterministic, not flaky.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-status-filter-determinism.ts
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
const TAG = `tsfd-${RUN_ID}`;

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
let currentCookieDepartmentId: string | null = null;
let currentCookieIsAllWorkspaces = false;

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
      get: (name: string) => {
        if (name !== "active_department_id") return undefined;
        if (currentCookieIsAllWorkspaces) return { value: "ALL" };
        return currentCookieDepartmentId ? { value: currentCookieDepartmentId } : undefined;
      },
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

  // Dynamically imported so the next/headers mock above is registered
  // before any transitive static import resolves the real cookies().
  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  const userIds: string[] = [];
  const departmentIds: string[] = [];
  const ticketIds: string[] = [];

  const callList = async (params: Record<string, string>): Promise<{ total: number; ids: string[]; statusIds: string[] } | { redirectTo: string }> => {
    try {
      const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, TicketTable);
      const tickets = (tableEl?.props.tickets as any[]) ?? [];
      return {
        total: tableEl?.props.total as number,
        ids: tickets.map((t) => t.id),
        statusIds: tickets.map((t) => t.status?.id),
      };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { redirectTo: err.digest.split(";")[2] ?? "" };
      }
      throw err;
    }
  };

  try {
    console.log("\n=== Fixtures: Finance + Accounting departments, each with their own Open/In Progress statuses ===\n");
    const finance = await createDepartment({ name: `${TAG}-Finance`, slug: `${TAG}-finance` });
    const accounting = await createDepartment({ name: `${TAG}-Accounting`, slug: `${TAG}-accounting` });
    departmentIds.push(finance.id, accounting.id);

    // Full control over each department's exact status/priority/category
    // set — clear the createDepartment() starter rows first.
    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: [finance.id, accounting.id] } } });
    await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: [finance.id, accounting.id] } } });
    await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: [finance.id, accounting.id] } } });

    const financeOpen = await prisma.ticketStatus.create({ data: { name: "Open", color: "#3b82f6", isClosed: false, isDefault: true, order: 1, departmentId: finance.id } });
    const financeInProgress = await prisma.ticketStatus.create({ data: { name: "In Progress", color: "#f59e0b", isClosed: false, order: 2, departmentId: finance.id } });
    const financeClosed = await prisma.ticketStatus.create({ data: { name: "Closed", color: "#6b7280", isClosed: true, order: 3, departmentId: finance.id } });
    const financeHigh = await prisma.ticketPriority.create({ data: { name: "High", level: 3, color: "#dc2626", departmentId: finance.id } });
    const financeLow = await prisma.ticketPriority.create({ data: { name: "Low", level: 1, color: "#16a34a", departmentId: finance.id } });
    const financeInvoices = await prisma.ticketCategory.create({ data: { name: "Invoices", color: "#6366f1", departmentId: finance.id } });

    // Accounting: SAME names as Finance's Open/In Progress, but genuinely
    // different rows/ids — this is the reconciliation test's raw material
    // (Accounting's In Progress id must never satisfy Finance's ticket
    // query, and switching workspace must resolve it to Finance's own id).
    const acctOpen = await prisma.ticketStatus.create({ data: { name: "Open", color: "#3b82f6", isClosed: false, isDefault: true, order: 1, departmentId: accounting.id } });
    const acctInProgress = await prisma.ticketStatus.create({ data: { name: "In Progress", color: "#f59e0b", isClosed: false, order: 2, departmentId: accounting.id } });
    // A status name that exists ONLY in Accounting, never in Finance — used
    // to prove a stale selection absent from Finance gets cleared, not
    // silently kept.
    const acctOnlyWaiting = await prisma.ticketStatus.create({ data: { name: "Waiting on Vendor", color: "#a855f7", isClosed: false, order: 3, departmentId: accounting.id } });

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);
    const agent = await prisma.user.create({
      data: { email: `${TAG}-agent@example.com`, name: `${TAG} Agent`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(agent.id);

    // Ticket A: Finance, In Progress, High priority, Invoices category, assigned.
    const ticketA = await prisma.ticket.create({
      data: {
        title: `${TAG} Ticket A (Finance, In Progress)`,
        description: "fixture",
        departmentId: finance.id,
        statusId: financeInProgress.id,
        priorityId: financeHigh.id,
        categoryId: financeInvoices.id,
        assignedAgentId: agent.id,
        requesterId: admin.id,
      },
    });
    // Ticket B: Finance, Open, Low priority, no category.
    const ticketB = await prisma.ticket.create({
      data: {
        title: `${TAG} Ticket B (Finance, Open)`,
        description: "fixture",
        departmentId: finance.id,
        statusId: financeOpen.id,
        priorityId: financeLow.id,
        requesterId: admin.id,
      },
    });
    // Ticket C: Finance, Closed — must never appear in the All Tickets default view.
    const ticketC = await prisma.ticket.create({
      data: {
        title: `${TAG} Ticket C (Finance, Closed)`,
        description: "fixture",
        departmentId: finance.id,
        statusId: financeClosed.id,
        requesterId: admin.id,
      },
    });
    // Ticket D: Accounting, In Progress — same status NAME as ticketA, but a
    // completely different department+statusId. Must never leak into a
    // Finance-scoped "In Progress" query.
    const ticketD = await prisma.ticket.create({
      data: {
        title: `${TAG} Ticket D (Accounting, In Progress)`,
        description: "fixture",
        departmentId: accounting.id,
        statusId: acctInProgress.id,
        requesterId: admin.id,
      },
    });
    ticketIds.push(ticketA.id, ticketB.id, ticketC.id, ticketD.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── 1-2. Finance contains an In Progress ticket; Finance + In Progress returns it ──
    console.log("\n1-2. Finance + In Progress returns Ticket A ===\n");
    currentCookieDepartmentId = finance.id;
    currentCookieIsAllWorkspaces = false;
    const defaultView = await callList({});
    if ("total" in defaultView) {
      check("Finance default view (no status filter) visibly includes Ticket A (In Progress)", defaultView.ids.includes(ticketA.id));
      check("Finance default view visibly includes Ticket B (Open)", defaultView.ids.includes(ticketB.id));
      check("Finance default view does NOT include Ticket C (Closed) — preserved implicit default scope", !defaultView.ids.includes(ticketC.id));
    } else {
      check("Finance default view did not unexpectedly redirect", false);
    }

    const financeInProgressResult = await callList({ statusId: financeInProgress.id });
    if ("total" in financeInProgressResult) {
      check("Finance + In Progress returns EXACTLY Ticket A", financeInProgressResult.ids.join(",") === ticketA.id, financeInProgressResult.ids.join(","));
    } else {
      check("Finance + In Progress did not unexpectedly redirect", false);
    }

    // ── 3. Finance + Open returns the correct Finance ticket ──
    console.log("\n3. Finance + Open returns Ticket B ===\n");
    const financeOpenResult = await callList({ statusId: financeOpen.id });
    if ("total" in financeOpenResult) {
      check("Finance + Open returns EXACTLY Ticket B", financeOpenResult.ids.join(",") === ticketB.id);
    } else {
      check("Finance + Open did not unexpectedly redirect", false);
    }

    // ── 4. Repeated selection gives the same result every time (no flakiness) ──
    console.log("\n4. Repeating Finance + In Progress 8 times gives the IDENTICAL result every time ===\n");
    let allRepeatsMatched = true;
    for (let i = 0; i < 8; i++) {
      const r = await callList({ statusId: financeInProgress.id });
      if (!("total" in r) || r.ids.join(",") !== ticketA.id) {
        allRepeatsMatched = false;
        console.error(`   [repeat ${i}] got: ${"total" in r ? r.ids.join(",") : r.redirectTo}`);
      }
    }
    check("All 8 repeated Finance + In Progress calls returned exactly Ticket A — deterministic, not flaky", allRepeatsMatched);

    // ── 5. All Workspaces -> Finance + In Progress works ──
    console.log("\n5. All Workspaces -> Finance + In Progress ===\n");
    currentCookieIsAllWorkspaces = true;
    currentCookieDepartmentId = null;
    await callList({}); // simulate landing on All Workspaces first
    currentCookieIsAllWorkspaces = false;
    currentCookieDepartmentId = finance.id;
    const afterAllToFinance = await callList({ statusId: financeInProgress.id });
    if ("total" in afterAllToFinance) {
      check("After All Workspaces -> Finance, Finance + In Progress still returns exactly Ticket A", afterAllToFinance.ids.join(",") === ticketA.id);
    } else {
      check("After All Workspaces -> Finance did not unexpectedly redirect", false);
    }

    // ── 6. Workspace A (Accounting) -> Finance + In Progress works ──
    console.log("\n6. Accounting -> Finance + In Progress (repeated several times) ===\n");
    let allTransitionsMatched = true;
    for (let i = 0; i < 5; i++) {
      currentCookieDepartmentId = accounting.id;
      await callList({}); // land on Accounting first
      currentCookieDepartmentId = finance.id;
      const r = await callList({ statusId: financeInProgress.id });
      if (!("total" in r) || r.ids.join(",") !== ticketA.id) {
        allTransitionsMatched = false;
        console.error(`   [transition ${i}] got: ${"total" in r ? r.ids.join(",") : r.redirectTo}`);
      }
    }
    check("5 repeated Accounting -> Finance transitions each correctly return exactly Ticket A for In Progress", allTransitionsMatched);
    check("Ticket D (Accounting's own In Progress ticket) never leaked into any Finance-scoped result above", true); // implied by exact-match checks above never including ticketD.id

    // ── 7. Old workspace status ID is reconciled to Finance's equivalent ID ──
    console.log("\n7. Accounting's In Progress id, switched to Finance -> reconciled to Finance's OWN In Progress id ===\n");
    currentCookieDepartmentId = finance.id;
    const reconcileResult = await callList({ statusId: acctInProgress.id, search: `${TAG}-searchterm`, sortBy: "priority", sortDir: "asc", page: "3" });
    check("Selecting Accounting's stale In Progress id while on Finance triggers a redirect (never silently queries Finance AND statusId=Accounting's id)", "redirectTo" in reconcileResult);
    if ("redirectTo" in reconcileResult) {
      const redirectUrl = new URL(reconcileResult.redirectTo, "http://localhost");
      check("...redirects to a corrected statusId (Finance's OWN In Progress id, not Accounting's)", redirectUrl.searchParams.get("statusId") === financeInProgress.id);
      check("...never keeps departmentId=Finance AND statusId=Accounting's id together (which would deterministically return zero rows)", redirectUrl.searchParams.get("statusId") !== acctInProgress.id);
      // ── 16. Pagination resets correctly after reconciliation ──
      check("...resets page to 1 (item 16)", redirectUrl.searchParams.get("page") === "1");
      // ── 17. Unrelated URL params survive ──
      check("...preserves the unrelated search param (item 17)", redirectUrl.searchParams.get("search") === `${TAG}-searchterm`);
      check("...preserves sortBy/sortDir (item 17)", redirectUrl.searchParams.get("sortBy") === "priority" && redirectUrl.searchParams.get("sortDir") === "asc");

      // Follow a version of the redirect's corrected statusId WITHOUT the
      // unrelated search term (which was only added above to prove it
      // survives the redirect — it doesn't match either fixture ticket's
      // title/description, so re-including it here would correctly return
      // zero results for an unrelated reason, not the thing under test).
      const followed = await callList({ statusId: redirectUrl.searchParams.get("statusId")! });
      if ("total" in followed) {
        check("Following the corrected statusId for real returns exactly Ticket A", followed.ids.join(",") === ticketA.id);
      } else {
        check("Following the corrected statusId did not itself redirect again", false);
      }
    }

    // ── 8. A status absent from Finance entirely is cleared ──
    console.log("\n8. A status that doesn't exist in Finance at all (Accounting-only 'Waiting on Vendor') is cleared, not kept ===\n");
    const clearedResult = await callList({ statusId: acctOnlyWaiting.id });
    check("Selecting a status with no Finance equivalent redirects (clears the param)", "redirectTo" in clearedResult);
    if ("redirectTo" in clearedResult) {
      const redirectUrl = new URL(clearedResult.redirectTo, "http://localhost");
      check("...the corrected URL has NO statusId param at all", !redirectUrl.searchParams.has("statusId"));
    }

    // ── 9. Grouped All-Workspaces status correctly filters with `IN` ──
    console.log("\n9. All Workspaces + a grouped (multi-id) 'Open' selection filters with statusId IN (...) ===\n");
    currentCookieIsAllWorkspaces = true;
    currentCookieDepartmentId = null;
    const groupedValue = `${financeOpen.id},${acctOpen.id}`;
    const groupedResult = await callList({ statusId: groupedValue });
    if ("total" in groupedResult) {
      check("Grouped All-Workspaces 'Open' selection returns Finance's Open ticket (Ticket B)", groupedResult.ids.includes(ticketB.id));
      check("Grouped All-Workspaces 'Open' selection does NOT include Ticket A (In Progress, not Open)", !groupedResult.ids.includes(ticketA.id));
      check("Grouped All-Workspaces 'Open' selection does NOT include Ticket D (Accounting's In Progress, not Open)", !groupedResult.ids.includes(ticketD.id));
    } else {
      check("Grouped All-Workspaces selection did not unexpectedly redirect", false);
    }
    currentCookieIsAllWorkspaces = false;
    currentCookieDepartmentId = finance.id;

    // ── 10. Priority has equivalent correct behaviour ──
    console.log("\n10. Finance + High priority returns exactly Ticket A ===\n");
    const priorityResult = await callList({ priorityId: financeHigh.id });
    if ("total" in priorityResult) {
      check("Finance + High priority returns exactly Ticket A", priorityResult.ids.join(",") === ticketA.id);
    } else {
      check("Finance + High priority did not unexpectedly redirect", false);
    }

    // ── 11. Category has equivalent correct behaviour ──
    console.log("\n11. Finance + Invoices category returns exactly Ticket A ===\n");
    const categoryResult = await callList({ categoryId: financeInvoices.id });
    if ("total" in categoryResult) {
      check("Finance + Invoices category returns exactly Ticket A", categoryResult.ids.join(",") === ticketA.id);
    } else {
      check("Finance + Invoices category did not unexpectedly redirect", false);
    }

    // ── 12-14. Status + Priority + Category combinations ──
    console.log("\n12-14. Status + Priority + Category combinations ===\n");
    const combo1 = await callList({ statusId: financeInProgress.id, priorityId: financeHigh.id });
    if ("total" in combo1) check("Status + Priority combination (In Progress + High) returns exactly Ticket A", combo1.ids.join(",") === ticketA.id);
    else check("Status+Priority combo did not unexpectedly redirect", false);

    const combo2 = await callList({ statusId: financeInProgress.id, categoryId: financeInvoices.id });
    if ("total" in combo2) check("Status + Category combination (In Progress + Invoices) returns exactly Ticket A", combo2.ids.join(",") === ticketA.id);
    else check("Status+Category combo did not unexpectedly redirect", false);

    const combo3 = await callList({ statusId: financeInProgress.id, priorityId: financeHigh.id, categoryId: financeInvoices.id });
    if ("total" in combo3) check("Status + Priority + Category combination returns exactly Ticket A", combo3.ids.join(",") === ticketA.id);
    else check("Status+Priority+Category combo did not unexpectedly redirect", false);

    // A combination that should legitimately return NOTHING (In Progress + Low, no such ticket) — proves it's not just always-matching.
    const comboNoMatch = await callList({ statusId: financeInProgress.id, priorityId: financeLow.id });
    if ("total" in comboNoMatch) check("A combination with no real match (In Progress + Low) correctly returns zero results", comboNoMatch.ids.length === 0);
    else check("No-match combo did not unexpectedly redirect", false);

    // ── 15. Assignee combination still works ──
    console.log("\n15. Status + Assignee combination works ===\n");
    const assigneeCombo = await callList({ statusId: financeInProgress.id, assignedAgentId: agent.id });
    if ("total" in assigneeCombo) check("Status + Assignee combination returns exactly Ticket A", assigneeCombo.ids.join(",") === ticketA.id);
    else check("Status+Assignee combo did not unexpectedly redirect", false);

    // ── 18. Closed-ticket page semantics remain correct ──
    console.log("\n18. Closed Tickets page still correctly shows Ticket C ===\n");
    const { default: ClosedTicketsPage } = await import("@/app/(main)/tickets/closed/page");
    const { TicketTable: ClosedTicketTable } = await import("@/components/tickets/ticket-table");
    const closedElement = await ClosedTicketsPage({ searchParams: Promise.resolve({}) });
    const [closedTableEl] = findElementsByType(closedElement, ClosedTicketTable);
    const closedIds = ((closedTableEl?.props.tickets as any[]) ?? []).map((t) => t.id);
    check("Closed Tickets page includes Ticket C (Finance, Closed)", closedIds.includes(ticketC.id));
    check("Closed Tickets page does NOT include Ticket A (In Progress, not closed)", !closedIds.includes(ticketA.id));
    check("Closed Tickets page does NOT include Ticket B (Open, not closed)", !closedIds.includes(ticketB.id));

    // ── 19. All Tickets retains its previous default open/non-closed semantics ──
    console.log("\n19. All Tickets (no filters at all) retains the previous default non-closed scope ===\n");
    const bareDefault = await callList({});
    if ("total" in bareDefault) {
      check("Bare /tickets (no params) includes Ticket A and Ticket B (non-closed)", bareDefault.ids.includes(ticketA.id) && bareDefault.ids.includes(ticketB.id));
      check("Bare /tickets (no params) still excludes Ticket C (Closed) — dropdown removal did not change the default", !bareDefault.ids.includes(ticketC.id));
    } else {
      check("Bare /tickets did not unexpectedly redirect", false);
    }

    // ── 20. No query relies on display names instead of canonical config IDs ──
    console.log("\n20. Canonical identity — Accounting's SAME-NAMED 'In Progress' ticket never leaks into a Finance-scoped query ===\n");
    const identityCheck = await callList({ statusId: financeInProgress.id });
    if ("total" in identityCheck) {
      check("Finance + In Progress (by real id) never includes Ticket D (Accounting's differently-id'd, same-NAMED 'In Progress' ticket)", !identityCheck.ids.includes(ticketD.id));
    } else {
      check("Identity check did not unexpectedly redirect", false);
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
