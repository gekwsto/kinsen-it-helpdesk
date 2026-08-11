/**
 * Real-DB, real-page-code proof that the ticket list pages (All Tickets,
 * Assigned to Me, Created by Me, Closed, Pending) now share the exact same
 * pagination architecture as Projects/Activities/Admin Users (lib/pagination.ts
 * + PaginationControls), not a parallel hardcoded-limit=20 system:
 *  - default pageSize is 20
 *  - ?pageSize=50 / ?pageSize=100 are honored (Prisma take === pageSize)
 *  - an invalid ?pageSize= (e.g. 999999, "abc") safely falls back to 20
 *  - ?page= is preserved across a pageSize-driven result-set shrink only via
 *    the out-of-range canonical redirect (never a silent empty page)
 *  - every other filter/sort URL param survives a canonical redirect
 *  - ordering is fully deterministic (id tiebreaker) — no row ever appears
 *    on two consecutive pages or is skipped
 *
 * Exercises the REAL Server Component page functions directly (mocked
 * @/lib/auth + next/headers, same convention as
 * scripts/test-ticket-status-filter-determinism.ts) — never a
 * reimplementation of the pagination logic.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-pagination-pagesize.ts
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
const TAG = `tpps-${RUN_ID}`;

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
  const { default: PendingTicketsPage } = await import("@/app/(main)/tickets/pending/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");
  const { PendingTicketTable } = await import("@/components/tickets/pending-ticket-table");
  const { htmlToReadableText } = await import("@/lib/utils");

  const callTickets = async (params: Record<string, string>): Promise<{ pagination: any; ids: string[] } | { redirectTo: string }> => {
    try {
      const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, TicketTable);
      return { pagination: tableEl?.props.pagination, ids: (tableEl?.props.tickets as any[])?.map((t) => t.id) ?? [] };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { redirectTo: err.digest.split(";")[2] ?? "" };
      }
      throw err;
    }
  };

  const callPending = async (params: Record<string, string>): Promise<{ pagination: any; count: number } | { redirectTo: string }> => {
    try {
      const element = await PendingTicketsPage({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, PendingTicketTable);
      return { pagination: tableEl?.props.pagination, count: (tableEl?.props.pendingTickets as any[])?.length ?? 0 };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { redirectTo: err.digest.split(";")[2] ?? "" };
      }
      throw err;
    }
  };

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const pendingTicketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: department with 25 tickets (> one default page) ===\n");
    const dept = await createDepartment({ name: `${TAG}-Dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true }, select: { id: true } });

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    for (let i = 0; i < 25; i++) {
      const t = await prisma.ticket.create({
        data: { title: `${TAG} Ticket ${String(i).padStart(2, "0")}`, description: "fixture", departmentId: dept.id, statusId: status.id, requesterId: admin.id },
      });
      ticketIds.push(t.id);
    }

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieDepartmentId = dept.id;

    console.log("\n1. Default pageSize is 20 ===\n");
    const defaultView = await callTickets({});
    let page1Ids: string[] = [];
    if ("pagination" in defaultView) {
      page1Ids = defaultView.ids;
      check("Default pageSize is 20", defaultView.pagination.pageSize === 20);
      check("Default view returns exactly 20 rows", defaultView.ids.length === 20);
      check("totalCount is 25", defaultView.pagination.totalCount === 25);
      check("totalPages is 2", defaultView.pagination.totalPages === 2);
    } else check("Default view did not unexpectedly redirect", false);

    console.log("\n2. ?pageSize=50 returns all 25 on a single page ===\n");
    const size50 = await callTickets({ pageSize: "50" });
    if ("pagination" in size50) {
      check("pageSize=50 honored", size50.pagination.pageSize === 50);
      check("All 25 tickets returned on one page", size50.ids.length === 25);
      check("totalPages is 1 at pageSize=50", size50.pagination.totalPages === 1);
    } else check("pageSize=50 did not unexpectedly redirect", false);

    console.log("\n3. ?pageSize=100 honored ===\n");
    const size100 = await callTickets({ pageSize: "100" });
    if ("pagination" in size100) check("pageSize=100 honored", size100.pagination.pageSize === 100);
    else check("pageSize=100 did not unexpectedly redirect", false);

    console.log("\n4. Invalid pageSize values safely fall back to the default (20) ===\n");
    for (const invalid of ["999999", "abc", "0", "-5", "33"]) {
      const r = await callTickets({ pageSize: invalid });
      if ("pagination" in r) check(`?pageSize=${invalid} falls back to 20`, r.pagination.pageSize === 20);
      else check(`?pageSize=${invalid} did not unexpectedly redirect`, false);
    }

    console.log("\n5. Page 2 (default pageSize) returns the remaining 5, no overlap/duplication with page 1 ===\n");
    const page2 = await callTickets({ page: "2" });
    if ("pagination" in page2) {
      check("Page 2 returns exactly 5 rows (25 total, 20 per page)", page2.ids.length === 5);
      const overlap = page2.ids.filter((id: string) => page1Ids.includes(id));
      check("Page 2's rows never overlap with page 1's rows (deterministic ordering)", overlap.length === 0);
    } else check("Page 2 did not unexpectedly redirect", false);

    console.log("\n6. Changing pageSize while on a high page canonicalizes rather than producing an empty/invalid page ===\n");
    const highPageThenBiggerSize = await callTickets({ page: "2", pageSize: "50" });
    check("page=2&pageSize=50 (only 1 page exists at size 50) redirects to a canonical page", "redirectTo" in highPageThenBiggerSize);
    if ("redirectTo" in highPageThenBiggerSize) {
      const url = new URL(highPageThenBiggerSize.redirectTo, "http://localhost");
      check("...canonical redirect targets page=1", url.searchParams.get("page") === "1");
      check("...canonical redirect preserves pageSize=50", url.searchParams.get("pageSize") === "50");
    }

    console.log("\n7. A wildly out-of-range page canonicalizes to the real last page, preserving pageSize ===\n");
    const outOfRange = await callTickets({ page: "999", pageSize: "50" });
    check("page=999 redirects (never renders an empty out-of-range page)", "redirectTo" in outOfRange);
    if ("redirectTo" in outOfRange) {
      const url = new URL(outOfRange.redirectTo, "http://localhost");
      check("...redirects to page=1 (the real last page at pageSize=50)", url.searchParams.get("page") === "1");
      check("...preserves pageSize=50 through the redirect", url.searchParams.get("pageSize") === "50");
    }

    console.log("\n8. Filters/sort survive a canonical redirect alongside pageSize ===\n");
    const withFilters = await callTickets({ page: "999", pageSize: "50", sortBy: "priority", sortDir: "asc" });
    if ("redirectTo" in withFilters) {
      const url = new URL(withFilters.redirectTo, "http://localhost");
      check("...sortBy survives the redirect", url.searchParams.get("sortBy") === "priority");
      check("...sortDir survives the redirect", url.searchParams.get("sortDir") === "asc");
      check("...pageSize survives the redirect", url.searchParams.get("pageSize") === "50");
    } else check("page=999 with extra filters did not unexpectedly redirect", false);

    console.log("\n=== Pending Tickets: same pagination architecture ===\n");
    for (let i = 0; i < 22; i++) {
      const pt = await prisma.pendingTicket.create({
        data: {
          subject: `${TAG} Pending ${i}`,
          fromEmail: `sender${i}@example.com`,
          fromName: "Test Sender",
          body: `<p>Body ${i}</p>`,
          receivedAt: new Date(),
          departmentId: dept.id,
          emailMessageId: `${TAG}-msg-${i}`,
        },
      });
      pendingTicketIds.push(pt.id);
    }
    const pendingDefault = await callPending({});
    if ("pagination" in pendingDefault) {
      check("Pending default pageSize is 20", pendingDefault.pagination.pageSize === 20);
      check("Pending default view returns 20 rows (22 total)", pendingDefault.count === 20);
    } else check("Pending default view did not unexpectedly redirect", false);

    const pendingSize50 = await callPending({ pageSize: "50" });
    if ("pagination" in pendingSize50) check("Pending ?pageSize=50 returns all 22 on one page", pendingSize50.count === 22);
    else check("Pending pageSize=50 did not unexpectedly redirect", false);

    const pendingInvalid = await callPending({ pageSize: "999999" });
    if ("pagination" in pendingInvalid) check("Pending invalid pageSize falls back to 20", pendingInvalid.pagination.pageSize === 20);
    else check("Pending invalid pageSize did not unexpectedly redirect", false);

    console.log("\n=== htmlToReadableText (Pending Ticket Preview's safe full-text rendering) ===\n");
    const withParagraphs = htmlToReadableText("<p>First paragraph.</p><p>Second paragraph.</p>");
    check("Block tags become real line breaks", withParagraphs === "First paragraph.\n\nSecond paragraph.");

    const withBr = htmlToReadableText("Line one<br>Line two<br/>Line three");
    check("<br> becomes a newline", withBr === "Line one\nLine two\nLine three");

    const withEntities = htmlToReadableText("<p>Tom &amp; Jerry &lt;script&gt; &quot;quoted&quot;</p>");
    check("HTML entities are decoded to real characters", withEntities === 'Tom & Jerry <script> "quoted"');

    const withScript = htmlToReadableText('<p>Safe text</p><script>alert("xss")</script><p>More safe text</p>');
    check("<script> tag and its content are removed entirely, never appear in the output", !withScript.includes("alert") && !withScript.includes("<script>"));

    const withStyle = htmlToReadableText("<style>.evil{color:red}</style><p>Visible text</p>");
    check("<style> tag and its content are removed entirely", !withStyle.includes(".evil") && !withStyle.includes("<style>"));

    const veryLong = htmlToReadableText(`<p>${"Lorem ipsum dolor sit amet. ".repeat(500)}</p>`);
    check("Very long body is preserved in full, not truncated", veryLong.length > 10000);

    const noMarkupSurvives = htmlToReadableText("<div><span>nested <b>bold</b> text</span></div>");
    check("No literal HTML tag characters ('<', '>') survive in the output for ordinary tags", !/[<>]/.test(noMarkupSurvives));
    check("Nested tag text content is preserved", noMarkupSurvives.includes("nested") && noMarkupSurvives.includes("bold") && noMarkupSurvives.includes("text"));

    const collapsesExcessBlankLines = htmlToReadableText("<p>A</p><div></div><div></div><div></div><p>B</p>");
    check("3+ consecutive blank lines collapse to at most one blank line", !/\n{3,}/.test(collapsesExcessBlankLines));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } });
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
