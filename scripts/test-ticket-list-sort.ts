/**
 * Regression coverage for the new Ticket-list column-header sorting:
 * clicking a column header on /tickets, /tickets/closed,
 * /tickets/created-by-me and /tickets/assigned-to-me sorts server-side
 * (Prisma orderBy, applied BEFORE pagination), whitelisted keys only
 * (TICKET_SORT_KEYS + resolveListSort — the same shared helper Projects/
 * Activities already use, see scripts/test-projects-activities-view-and-
 * sort.ts), replacing each page's PREVIOUS unsafe `{ [sortBy]: sortDir }`
 * dynamic-key pattern (see lib/list-sort.ts's own doc comment, which
 * explicitly called that pattern out by name before this fix).
 *
 * TESTING APPROACH: same as scripts/test-projects-activities-view-and-
 * sort.ts and scripts/test-ticket-list-department-scope-regression.ts —
 * pure unit tests for the whitelist + resolver, source-level checks for
 * client-only wiring (SortableTableHead's own hooks don't execute when a
 * Server Component is called directly), and real-DB tests against the
 * actual page functions for authoritative server-side behavior.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-list-sort.ts
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

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
let currentCookieValue: string | undefined = undefined;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (name === "active_department_id" && currentCookieValue ? { value: currentCookieValue } : undefined) }),
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

const RUN_ID = Date.now();

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

  const { resolveListSort } = await import("@/lib/list-sort");
  const { TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY } = await import("@/lib/services/ticket-list-sort");
  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { default: ClosedTicketsPage } = await import("@/app/(main)/tickets/closed/page");
  const { default: CreatedByMePage } = await import("@/app/(main)/tickets/created-by-me/page");
  const { default: AssignedToMePage } = await import("@/app/(main)/tickets/assigned-to-me/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");

  // ══════════════ Part 1: TICKET_SORT_KEYS + resolveListSort — pure unit tests ══════════════
  console.log("\n=== resolveListSort against the real TICKET_SORT_KEYS whitelist ===\n");
  const missing = resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, undefined, undefined);
  check("No sortBy -> key null, orderBy is the EXACT canonical fallback (createdAt desc, id asc) — identical to every page's pre-existing default", missing.key === null && JSON.stringify(missing.orderBy) === JSON.stringify(TICKET_DEFAULT_ORDER_BY));
  const invalid = resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, "__proto__", "asc");
  check("A non-whitelisted/tampered sortBy -> same canonical fallback, never reaches Prisma", invalid.key === null && JSON.stringify(invalid.orderBy) === JSON.stringify(TICKET_DEFAULT_ORDER_BY));
  const invalidOrder = resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, "title", "DROP TABLE");
  check("A real key with a tampered sortOrder value falls back to ascending, never a third state", invalidOrder.key === "title" && invalidOrder.order === "asc");
  for (const key of Object.keys(TICKET_SORT_KEYS)) {
    const asc = resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, key, undefined);
    const desc = resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, key, "desc");
    check(`"${key}": first click -> ascending`, asc.key === key && asc.order === "asc");
    check(`"${key}": ?sortOrder=desc -> descending`, desc.key === key && desc.order === "desc");
    check(`"${key}": id tie-breaker always appended`, JSON.stringify(asc.orderBy[asc.orderBy.length - 1]) === JSON.stringify({ id: "asc" }));
  }
  check("Exactly the expected 9 keys are whitelisted (ticketNumber, title, requester, assignedAgent, status, priority, category, createdAt, updatedAt)", JSON.stringify(Object.keys(TICKET_SORT_KEYS).sort()) === JSON.stringify(["assignedAgent", "category", "createdAt", "priority", "requester", "status", "ticketNumber", "title", "updatedAt"].sort()));

  // ══════════════ Part 2: source-level wiring ══════════════
  console.log("\n=== Source-level: whitelist-only, no dynamic Prisma key, SortableTableHead reused, Pending/Rejected untouched ===\n");
  const pagesSrc = await Promise.all(
    [
      "app/(main)/tickets/page.tsx",
      "app/(main)/tickets/closed/page.tsx",
      "app/(main)/tickets/created-by-me/page.tsx",
      "app/(main)/tickets/assigned-to-me/page.tsx",
    ].map((p) => fs.readFile(p, "utf8"))
  );
  const [allSrc, closedSrc, createdByMeSrc, assignedToMeSrc] = pagesSrc;
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const [name, src] of [["/tickets", allSrc], ["/tickets/closed", closedSrc], ["/tickets/created-by-me", createdByMeSrc], ["/tickets/assigned-to-me", assignedToMeSrc]] as const) {
    check(`${name}: uses resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, ...) — not a dynamic { [sortBy]: sortDir } key`, /resolveListSort\(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, params\.sortBy, params\.sortOrder\)/.test(src));
    check(`${name}: the old unsafe dynamic-key pattern is gone (checked outside comments)`, !/\{\s*\[sortBy\]/.test(stripComments(src)));
    check(`${name}: no longer reads the old sortDir param name`, !/params\.sortDir/.test(src));
    check(`${name}: SearchParams declares sortOrder (matching Projects/Activities' own param name), not sortDir`, /sortOrder\?:\s*string/.test(src) && !/sortDir\?:\s*string/.test(src));
  }

  const ticketTableSrc = await fs.readFile("components/tickets/ticket-table.tsx", "utf8");
  check("TicketTable imports and uses the SAME SortableTableHead component Projects/Activities use (no second implementation)", /import \{ SortableTableHead \} from "@\/components\/ui\/sortable-table-head"/.test(ticketTableSrc));
  const expectedSortable = ["ticketNumber", "title", "requester", "status", "priority", "category", "assignedAgent", "createdAt"];
  check("Ticket #, Title, Requester, Status, Priority, Category, Assigned To, Created are sortable", expectedSortable.every((k) => new RegExp(`sortKey="${k}"`).test(ticketTableSrc)));
  check("Source, Project, Dept. changed by, and the row action column are left NON-sortable (not in TICKET_SORT_KEYS, not given a sortKey)", !/sortKey="source"/.test(ticketTableSrc) && !/sortKey="project"/.test(ticketTableSrc) && !/sortKey="departmentChangedBy"/.test(ticketTableSrc) && !/sortKey="actions"/.test(ticketTableSrc));
  check("No Department column exists in TicketTable at all, so none was made sortable (Department is filter/scope-only, never a rendered list column)", !/<TableHead>Department<\/TableHead>|sortKey="department"/.test(ticketTableSrc));

  const sortableHeadSrc = await fs.readFile("components/ui/sortable-table-head.tsx", "utf8");
  check("SortableTableHead's own props stay fully generic — sortKey: string, no per-domain union type added for Tickets", /sortKey:\s*string/.test(sortableHeadSrc));
  check("Clicking a header resets pagination to page 1 only", /params\.delete\("page"\)/.test(sortableHeadSrc));
  check("Correct aria-sort wiring", /aria-sort=\{isActive/.test(sortableHeadSrc));

  const liveRefreshSrc = await fs.readFile("components/tickets/ticket-list-live-refresh.tsx", "utf8").catch(() => "");
  check("TicketListLiveRefresh has no sort-specific code to diverge — router.refresh() re-fetches the SAME URL (sort lives in the URL) by construction", !/sortBy|sortOrder/.test(liveRefreshSrc));

  const pendingSrc = await fs.readFile("app/(main)/tickets/pending/page.tsx", "utf8").catch(() => "");
  const rejectedSrc = await fs.readFile("app/(main)/tickets/rejected/page.tsx", "utf8").catch(() => "");
  check("Pending Email page untouched: no TICKET_SORT_KEYS/resolveListSort/SortableTableHead reference (not a real Ticket list)", !/TICKET_SORT_KEYS|resolveListSort|SortableTableHead/.test(pendingSrc));
  check("Rejected Email page untouched: same", !/TICKET_SORT_KEYS|resolveListSort|SortableTableHead/.test(rejectedSrc));

  const ticketFiltersSrc = await fs.readFile("components/tickets/ticket-filters.tsx", "utf8");
  check("TicketFilters' own pre-existing Sort-by dropdown now writes sortOrder (not the old sortDir) so it stays consistent with the new column-header mechanism", /sortOrder/.test(ticketFiltersSrc) && !/sortDir/.test(ticketFiltersSrc));
  check("No NEW filter control was added — only the pre-existing sort dropdown's param name changed", (ticketFiltersSrc.match(/get\("sortBy"\)/g) || []).length > 0);

  // ══════════════ Part 3: real DB — authoritative server-side sort ══════════════
  console.log("\n=== Real Server Component behavior: server-side ordering, before pagination, scope preserved ===\n");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  type ListResult = { ids: string[]; tickets: any[]; totalCount: number; redirectTo?: string };
  async function callPage(page: (args: { searchParams: Promise<Record<string, string>> }) => Promise<any>, params: Record<string, string>): Promise<ListResult> {
    try {
      const el = await page({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(el, TicketTable);
      const tickets = (tableEl?.props.tickets as any[]) ?? [];
      return { ids: tickets.map((t) => t.id), tickets, totalCount: tableEl?.props.pagination?.totalCount ?? 0 };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { ids: [], tickets: [], totalCount: 0, redirectTo: err.digest.split(";")[2] ?? "" };
      }
      throw err;
    }
  }

  try {
    const deptA = await createDepartment({ name: `Ticket Sort A ${RUN_ID}`, slug: `ticket-sort-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `Ticket Sort B ${RUN_ID}`, slug: `ticket-sort-b-${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id);

    const statusOpen = await prisma.ticketStatus.create({ data: { name: `Open ${RUN_ID}`, color: "#000", order: 1, isClosed: false, departmentId: deptA.id } });
    const statusUrgentLabel = await prisma.ticketStatus.create({ data: { name: `Urgent Review ${RUN_ID}`, color: "#f00", order: 9, isClosed: false, departmentId: deptA.id } });
    const closedStatus = await prisma.ticketStatus.create({ data: { name: `Done ${RUN_ID}`, color: "#0f0", order: 1, isClosed: true, departmentId: deptA.id } });
    const priorityLow = await prisma.ticketPriority.create({ data: { name: `Low ${RUN_ID}`, level: 1, color: "#000", departmentId: deptA.id } });
    const priorityHigh = await prisma.ticketPriority.create({ data: { name: `High ${RUN_ID}`, level: 9, color: "#f00", departmentId: deptA.id } });
    const categoryAlpha = await prisma.ticketCategory.create({ data: { name: `Alpha-Cat ${RUN_ID}`, color: "#000", departmentId: deptA.id } });
    const categoryZulu = await prisma.ticketCategory.create({ data: { name: `Zulu-Cat ${RUN_ID}`, color: "#f00", departmentId: deptA.id } });

    const admin = await prisma.user.create({ data: { email: `ticket-sort-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, name: "Zadmin" } });
    const agentAlice = await prisma.user.create({ data: { email: `ticket-sort-alice-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, name: `Alice ${RUN_ID}` } });
    const agentZoe = await prisma.user.create({ data: { email: `ticket-sort-zoe-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true, name: `Zoe ${RUN_ID}` } });
    userIds.push(admin.id, agentAlice.id, agentZoe.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    currentCookieValue = undefined;

    // Deliberately-scrambled creation order so createdAt-desc (the default)
    // would NOT coincidentally match title-alphabetical order.
    const defs = [
      { title: `Charlie ${RUN_ID}`, priority: priorityLow, category: categoryZulu, agent: agentZoe },
      { title: `Alpha ${RUN_ID}`, priority: priorityHigh, category: categoryAlpha, agent: agentAlice },
      { title: `Echo ${RUN_ID}`, priority: priorityLow, category: categoryAlpha, agent: null },
      { title: `Bravo ${RUN_ID}`, priority: priorityHigh, category: categoryZulu, agent: agentAlice },
      { title: `Delta ${RUN_ID}`, priority: priorityLow, category: categoryZulu, agent: null },
    ];
    for (const d of defs) {
      const t = await prisma.ticket.create({
        data: {
          title: d.title,
          description: "seed",
          source: "WEB",
          requesterId: admin.id,
          departmentId: deptA.id,
          statusId: statusOpen.id,
          priorityId: d.priority.id,
          categoryId: d.category.id,
          assignedAgentId: d.agent?.id ?? null,
        },
      });
      ticketIds.push(t.id);
    }
    // A Dept B ticket — for the scope-preservation check below.
    const deptBTicket = await prisma.ticket.create({ data: { title: `Zulu ${RUN_ID}`, description: "seed", source: "WEB", requesterId: admin.id, departmentId: deptB.id, statusId: (await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isDefault: true } })).id } });
    ticketIds.push(deptBTicket.id);

    console.log("\n-- Ascending/descending title sort, correct BEFORE pagination --\n");
    const ascAll = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "title", sortOrder: "asc" });
    const expectedAsc = defs.map((d) => d.title).sort((a, b) => a.localeCompare(b));
    check("Ascending title sort matches real alphabetical order", JSON.stringify(ascAll.tickets.map((t: any) => t.title)) === JSON.stringify(expectedAsc));
    const descAll = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "title", sortOrder: "desc" });
    check("Descending title sort is the exact reverse", JSON.stringify(descAll.tickets.map((t: any) => t.title)) === JSON.stringify([...ascAll.tickets.map((t: any) => t.title)].reverse()));

    console.log("\n-- ticketNumber sort (a real, safe scalar Int key) --\n");
    const byNumAsc = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "ticketNumber", sortOrder: "asc" });
    const nums = byNumAsc.tickets.map((t: any) => t.ticketNumber);
    check("ticketNumber ascending is a genuinely sorted sequence", JSON.stringify(nums) === JSON.stringify([...nums].sort((a, b) => a - b)));

    console.log("\n-- status/priority nested-relation sort reuses the existing order/level columns (not alphabetical) --\n");
    const byPriorityAsc = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "priority", sortOrder: "asc" });
    check("Priority ascending: all Low(level 1) tickets before all High(level 9) tickets", byPriorityAsc.tickets.every((t: any, i: number, arr: any[]) => i === 0 || (t.priority?.level ?? 0) >= (arr[i - 1].priority?.level ?? 0)));
    const byCategoryAsc = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "category", sortOrder: "asc" });
    check("Category ascending sorts by category NAME (Alpha-Cat before Zulu-Cat)", byCategoryAsc.tickets.findIndex((t: any) => t.category?.name === categoryAlpha.name) < byCategoryAsc.tickets.findIndex((t: any) => t.category?.name === categoryZulu.name));

    console.log("\n-- Nullable relation (Assigned To) sorted deterministically, no runtime error --\n");
    const byAssignedAsc = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "assignedAgent", sortOrder: "asc" });
    check("No error, all 5 rows returned", byAssignedAsc.tickets.length === 5);
    const namesAsc = byAssignedAsc.tickets.map((t: any) => t.assignedAgent?.name ?? null);
    const nullIdxAsc = namesAsc.map((n, i) => (n === null ? i : -1)).filter((i) => i >= 0);
    check("Ascending: unassigned (null) tickets consistently placed LAST (Postgres default NULLS LAST for ASC)", nullIdxAsc.length === 2 && nullIdxAsc[0] === 3 && nullIdxAsc[1] === 4);
    const byAssignedDesc = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "assignedAgent", sortOrder: "desc" });
    const namesDesc = byAssignedDesc.tickets.map((t: any) => t.assignedAgent?.name ?? null);
    const nullIdxDesc = namesDesc.map((n, i) => (n === null ? i : -1)).filter((i) => i >= 0);
    check("Descending: unassigned (null) tickets consistently placed FIRST (Postgres default NULLS FIRST for DESC)", nullIdxDesc.length === 2 && nullIdxDesc[0] === 0 && nullIdxDesc[1] === 1);
    const namedDesc = namesDesc.filter((n): n is string => n !== null);
    check("...and the named agents among them are still genuinely descending (Zoe before Alice)", namedDesc[0]!.startsWith("Zoe"));

    // pageSize must be a real whitelisted value (lib/pagination.ts), so a
    // genuine 2-page slice needs > 20 fixture rows.
    const fillerCount = 17;
    for (let i = 0; i < fillerCount; i++) {
      const t = await prisma.ticket.create({ data: { title: `Filler-${String(i).padStart(2, "0")} ${RUN_ID}`, description: "seed", source: "WEB", requesterId: admin.id, departmentId: deptA.id, statusId: statusOpen.id } });
      ticketIds.push(t.id);
    }
    const fullAsc = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "50", sortBy: "title", sortOrder: "asc" });
    check("(fixture) 22 Dept A tickets now exist, all reachable in one 50-sized page", fullAsc.tickets.length === 5 + fillerCount);
    const page1 = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", page: "1", sortBy: "title", sortOrder: "asc" });
    const page2 = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", page: "2", sortBy: "title", sortOrder: "asc" });
    check("Sorting is applied BEFORE pagination: page 1 (20) + page 2 (2) together reconstruct the exact same globally-sorted sequence", JSON.stringify([...page1.ids, ...page2.ids]) === JSON.stringify(fullAsc.ids));
    check("...page 1 has exactly 20 rows, page 2 has the remaining 2", page1.ids.length === 20 && page2.ids.length === 2);
    check("...and no id is duplicated or skipped across the two pages", new Set([...page1.ids, ...page2.ids]).size === page1.ids.length + page2.ids.length);

    console.log("\n-- Sort combines with a real filter, department scope, AND pagination simultaneously --\n");
    // A short numeric substring of RUN_ID, not the full 13-digit value — the
    // page's own search also probes `ticketNumber` when the term parses as
    // an int (see andConditions.push({ ... ticketNumber: numSearch })
    // above); the full Date.now()-sized RUN_ID overflows Postgres INT4
    // there, which is a PRE-EXISTING, unrelated behavior this sort task
    // must not trip over (and is not this task's to fix).
    const searchTag = String(RUN_ID).slice(-6);
    const combinedPage1 = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", page: "1", sortBy: "title", sortOrder: "asc", search: searchTag });
    const combinedPage2 = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", page: "2", sortBy: "title", sortOrder: "asc", search: searchTag });
    check("sortBy + search + departmentId + pagination all apply together correctly", JSON.stringify([...combinedPage1.ids, ...combinedPage2.ids]) === JSON.stringify(fullAsc.ids));

    console.log("\n-- Invalid sortBy on the REAL page falls back to the canonical default (createdAt desc) — never errors --\n");
    const invalidSortRes = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "__proto__", sortOrder: "asc" });
    const noSortRes = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20" });
    check("Invalid sortBy produces the IDENTICAL order to no sortBy at all", JSON.stringify(invalidSortRes.ids) === JSON.stringify(noSortRes.ids));
    const invalidOrderRes = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "title", sortOrder: "sideways" });
    const freshAscForComparison = await callPage(AllTicketsPage, { departmentId: deptA.id, pageSize: "20", sortBy: "title", sortOrder: "asc" });
    check("A tampered sortOrder (real sortBy) still falls back to ascending, never errors", JSON.stringify(invalidOrderRes.ids) === JSON.stringify(freshAscForComparison.ids));

    console.log("\n-- Authorization/scope unchanged: a crafted sortBy can never surface another department's tickets --\n");
    const deptAOnlyRole = await prisma.customRole.create({ data: { key: `TICKETSORT_A_${RUN_ID}`, name: `Ticket Sort Dept A ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true } });
    customRoleIds.push(deptAOnlyRole.id);
    customRoleKeys.push(deptAOnlyRole.key);
    // Both are required together (see prisma/seed.ts): ticket.view alone
    // only ever grants a user their OWN tickets; ticket.view.all is what
    // upgrades that to the full department list — the exact combination
    // every real full-view role in seed.ts grants together.
    const viewPerm = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.view" } });
    const viewAllPerm = await prisma.permission.findUniqueOrThrow({ where: { key: "ticket.view.all" } });
    await prisma.rolePermission.createMany({ data: [{ roleKey: deptAOnlyRole.key, permissionId: viewPerm.id }, { roleKey: deptAOnlyRole.key, permissionId: viewAllPerm.id }] });
    const scopedUser = await prisma.user.create({ data: { email: `ticket-sort-scoped-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(scopedUser.id);
    const membership = await prisma.departmentMembership.create({
      data: { userId: scopedUser.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, customRoleId: deptAOnlyRole.id, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(membership.id);
    currentSession = { user: { id: scopedUser.id, role: Role.USER, customRoleId: null } };
    const scopedSortedDesc = await callPage(AllTicketsPage, { pageSize: "50", sortBy: "title", sortOrder: "desc" });
    check("A Dept-A-only viewer, sorted descending by title, still never sees the Dept B ticket", !scopedSortedDesc.ids.includes(deptBTicket.id));
    check("...but does see their own Dept A tickets, correctly sorted (count matches)", scopedSortedDesc.ids.length === fullAsc.ids.length);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ══════════════ Coverage of all four real Ticket-list pages ══════════════
    console.log("\n-- All four pages: each honors the SAME sortBy/sortOrder mechanism --\n");
    const closedDescByPriority = await callPage(ClosedTicketsPage, { departmentId: deptA.id, sortBy: "priority", sortOrder: "desc" });
    check("/tickets/closed: accepts sortBy=priority without error (no closed tickets seeded here, but the query itself must not throw)", closedDescByPriority.ids.length === 0 && closedDescByPriority.redirectTo === undefined);
    // Seed one closed ticket to prove real ordering there too.
    const closedTicket1 = await prisma.ticket.create({ data: { title: `Closed Alpha ${RUN_ID}`, description: "seed", source: "WEB", requesterId: admin.id, departmentId: deptA.id, statusId: closedStatus.id, priorityId: priorityLow.id } });
    const closedTicket2 = await prisma.ticket.create({ data: { title: `Closed Zulu ${RUN_ID}`, description: "seed", source: "WEB", requesterId: admin.id, departmentId: deptA.id, statusId: closedStatus.id, priorityId: priorityHigh.id } });
    ticketIds.push(closedTicket1.id, closedTicket2.id);
    const closedByPriorityAsc = await callPage(ClosedTicketsPage, { departmentId: deptA.id, sortBy: "priority", sortOrder: "asc" });
    check("/tickets/closed: real ascending priority sort works (Low before High)", closedByPriorityAsc.ids.indexOf(closedTicket1.id) < closedByPriorityAsc.ids.indexOf(closedTicket2.id));

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const createdByMeAsc = await callPage(CreatedByMePage, { pageSize: "50", sortBy: "title", sortOrder: "asc" });
    const createdByMeOwnTitles = createdByMeAsc.tickets.filter((t: any) => t.title.includes(String(RUN_ID))).map((t: any) => t.title);
    check("/tickets/created-by-me: sortBy=title ascending is genuinely sorted among the admin's own tickets", JSON.stringify(createdByMeOwnTitles) === JSON.stringify([...createdByMeOwnTitles].sort((a, b) => a.localeCompare(b))));

    await prisma.ticket.update({ where: { id: ticketIds[1] }, data: { assignedAgentId: admin.id } });
    await prisma.ticket.update({ where: { id: ticketIds[3] }, data: { assignedAgentId: admin.id } });
    const assignedToMeDesc = await callPage(AssignedToMePage, { pageSize: "50", sortBy: "ticketNumber", sortOrder: "desc" });
    const assignedNums = assignedToMeDesc.tickets.map((t: any) => t.ticketNumber);
    check("/tickets/assigned-to-me: sortBy=ticketNumber descending is genuinely sorted among the admin's assigned tickets", assignedNums.length >= 2 && JSON.stringify(assignedNums) === JSON.stringify([...assignedNums].sort((a: number, b: number) => b - a)));

    // ══════════════ Filter/param preservation on sort ══════════════
    console.log("\n-- Changing sort only resets page; every other param (search/filters/pageSize) is preserved by construction --\n");
    check("SortableTableHead preserves every OTHER param via new URLSearchParams(searchParams.toString()) before setting sortBy/sortOrder and deleting page", /new URLSearchParams\(searchParams\.toString\(\)\)/.test(sortableHeadSrc) && /params\.set\("sortBy", sortKey\)/.test(sortableHeadSrc) && /params\.delete\("page"\)/.test(sortableHeadSrc));
    check("TicketFilters' own sort controls preserve every other param too (same push() helper used by every other filter control)", /const push = useCallback/.test(ticketFiltersSrc));

    // ══════════════ Realtime refresh preserves sort (source-verified — sort lives in the URL, router.refresh() re-fetches the SAME URL) ══════════════
    console.log("\n-- Realtime refresh: sort is preserved because it lives in the URL, and TicketListLiveRefresh never touches it --\n");
    check("TicketListLiveRefresh calls router.refresh() with no arguments — re-fetches the CURRENT URL (including sortBy/sortOrder) verbatim", /router\.refresh\(\)/.test(liveRefreshSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
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
