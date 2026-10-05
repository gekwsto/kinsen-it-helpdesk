/**
 * "Assigned to" Ticket filter — the audit found this ALREADY mostly built
 * (app/(main)/tickets/page.tsx's `assignedAgentId`/`agents` wiring,
 * components/tickets/ticket-filters.tsx's "Agent" dropdown, `unassigned`
 * toggle) and reused/corrected it rather than duplicating it: only the
 * visible label text changed ("Agent"/"Any agent" -> "Assigned to"/
 * "All assignees" — see the final report for the full audit). Every
 * behavioral requirement below was already implemented by the existing
 * `assignedAgentId` where-clause condition, the existing scoped agents
 * query (Role IT_AGENT/ADMIN, isActive — the same query the ticket
 * creation form and Closed Tickets page already reuse, see
 * lib/permissions.ts's isAgent), and the existing generic `push()`/
 * `handleSelect()` URL-param helpers every other filter already goes
 * through — this file proves that reuse actually holds.
 *
 * Exercises the REAL app/(main)/tickets/page.tsx Server Component function
 * directly (mocked @/lib/auth + next/headers cookies()), same established
 * pattern as scripts/test-ticket-list-department-scope-regression.ts.
 *
 * Must run with --experimental-test-module-mocks (Node 24).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-assigned-to-filter.ts
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
// "ALL" (All Workspaces) — this file tests the assignedAgentId filter, a
// concern orthogonal to workspace scoping (see this task's own workspace-
// scoping fix: Tickets pages now default to the active Workspace instead
// of the full union when no cookie is set). Safe for every session here —
// see scripts/test-ticket-assigned-to-filter-all-pages.ts's identical fix
// for the full rationale.
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
  const { Role, DepartmentRole, MembershipSource, AuthProvider } = await import("@prisma/client");
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
  const { TicketTable } = await import("@/components/tickets/ticket-table");
  const { TicketFilters } = await import("@/components/tickets/ticket-filters");

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];

  type ListResult = { ids: string[]; totalCount: number; pageSize: number; agentOptionIds: string[] };
  async function callPage(params: Record<string, string>): Promise<ListResult> {
    try {
      const element = await AllTicketsPage({ searchParams: Promise.resolve(params) });
      const [tableEl] = findElementsByType(element, TicketTable);
      const [filtersEl] = findElementsByType(element, TicketFilters);
      const tickets = (tableEl?.props.tickets as any[]) ?? [];
      return {
        ids: tickets.map((t) => t.id),
        totalCount: tableEl?.props.pagination?.totalCount ?? 0,
        pageSize: tableEl?.props.pagination?.pageSize ?? 0,
        agentOptionIds: ((filtersEl?.props.options.agents as any[]) ?? []).map((a) => a.id),
      };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        console.error(`     (unexpected redirect for params=${JSON.stringify(params)}: ${err.digest})`);
        return { ids: [], totalCount: 0, pageSize: 0, agentOptionIds: [] };
      }
      throw err;
    }
  }

  try {
    // ══════════════ Fixtures ══════════════
    const deptA = await createDepartment({ name: `Assignee Filter A ${RUN_ID}`, slug: `assignee-filter-a-${RUN_ID}` });
    const deptB = await createDepartment({ name: `Assignee Filter B ${RUN_ID}`, slug: `assignee-filter-b-${RUN_ID}` });
    deptIds.push(deptA.id, deptB.id);

    const [statusAOpen, statusAInProgress, statusAPendingUser, statusB] = await Promise.all([
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Open" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "In Progress" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, name: "Pending User" } }),
      prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isDefault: true } }),
    ]);
    const statusAOther = statusAInProgress;

    const requester = await prisma.user.create({ data: { email: `assignee-filter-req-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(requester.id);
    const admin = await prisma.user.create({ data: { email: `assignee-filter-admin-${RUN_ID}@kinsen.gr`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(admin.id);
    const agentX = await prisma.user.create({ data: { email: `assignee-filter-agentx-${RUN_ID}@kinsen.gr`, name: "Agent X", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentX.id);
    const agentY = await prisma.user.create({ data: { email: `assignee-filter-agenty-${RUN_ID}@kinsen.gr`, name: "Agent Y", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(agentY.id);
    const inactiveAgent = await prisma.user.create({ data: { email: `assignee-filter-inactive-${RUN_ID}@kinsen.gr`, name: "Inactive Agent", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: false } });
    userIds.push(inactiveAgent.id);

    // Dept-A-only viewer: full ticket view in A, NO membership in B at all —
    // proves the filter can never be used to see across an unauthorized
    // department boundary (requirement 11).
    const deptAOnlyViewer = await prisma.user.create({ data: { email: `assignee-filter-scoped-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(deptAOnlyViewer.id);
    const scopedMembership = await prisma.departmentMembership.create({
      data: { userId: deptAOnlyViewer.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(scopedMembership.id);

    const mk = async (dept: { id: string }, status: { id: string }, assignedAgentId: string | null, title: string) => {
      const t = await prisma.ticket.create({ data: { title, description: "d", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: status.id, assignedAgentId } });
      ticketIds.push(t.id);
      return t;
    };
    const t1 = await mk(deptA, statusAOpen, agentX.id, `A-open-agentX ${RUN_ID}`);
    const t2 = await mk(deptA, statusAOpen, agentY.id, `A-open-agentY ${RUN_ID}`);
    const t3 = await mk(deptA, statusAOpen, null, `A-open-unassigned ${RUN_ID}`);
    const t4 = await mk(deptB, statusB, agentX.id, `B-agentX ${RUN_ID}`);
    const t5 = await mk(deptA, statusAOther, agentX.id, `A-other-agentX ${RUN_ID}`);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== 7/8. Filters by the selected user id; other users' tickets excluded ===\n");
    const byAgentX = await callPage({ assignedAgentId: agentX.id });
    check("7. assignedAgentId=agentX -> includes every ticket actually assigned to agentX (t1, t4, t5)", [t1.id, t4.id, t5.id].every((id) => byAgentX.ids.includes(id)));
    check("8. ...excludes agentY's ticket (t2)", !byAgentX.ids.includes(t2.id));
    check("8. ...excludes the unassigned ticket (t3)", !byAgentX.ids.includes(t3.id));
    check("Options use the stable user id, not name/email, as the filter value", byAgentX.agentOptionIds.includes(agentX.id) && byAgentX.agentOptionIds.includes(agentY.id));
    check("Options never include an inactive user", !byAgentX.agentOptionIds.includes(inactiveAgent.id));
    check("Options contain no duplicate user ids", new Set(byAgentX.agentOptionIds).size === byAgentX.agentOptionIds.length);
    check("Options never expose the plain requester (not agent-capable)", !byAgentX.agentOptionIds.includes(requester.id));

    console.log("\n=== 9. Combines correctly with department AND status ===\n");
    const withDept = await callPage({ assignedAgentId: agentX.id, departmentId: deptA.id });
    check("assignedAgentId + departmentId=A -> t1 and t5 (both in A)", withDept.ids.includes(t1.id) && withDept.ids.includes(t5.id));
    check("...excludes t4 (same agent, but department B)", !withDept.ids.includes(t4.id));

    const withDeptAndStatus = await callPage({ assignedAgentId: agentX.id, departmentId: deptA.id, statusId: statusAOpen.id });
    check("...+ statusId=open -> only t1 (t5 has a different status)", withDeptAndStatus.ids.includes(t1.id) && !withDeptAndStatus.ids.includes(t5.id));

    const mismatched = await callPage({ assignedAgentId: agentX.id, departmentId: deptA.id, statusId: statusAPendingUser.id });
    check("A valid-in-department status that simply matches no ticket -> zero rows, not a silent OR", mismatched.ids.length === 0);

    console.log("\n=== 10. Pagination preserves the filter; changing/clearing resets to page 1 (verified at the source, same generic push()) ===\n");
    // 19 more, same agent+department as t1/t5, ADDED ONLY NOW (after checks
    // 7-9 already ran against the smaller set) to push the filtered result
    // set past ONE page at the smallest real page size (20) — pageSize is a
    // fixed enum (20/50/100; see lib/pagination.ts), so a real >1-page
    // pagination proof needs a real fixture count, not an artificial size.
    const extraAgentXTickets: string[] = [];
    for (let i = 0; i < 19; i++) {
      const t = await mk(deptA, statusAOpen, agentX.id, `A-open-agentX-extra-${i} ${RUN_ID}`);
      extraAgentXTickets.push(t.id);
    }
    // t1 + t5 + 19 extras = 21 tickets assigned to agentX in deptA -> 2 pages at pageSize=20.
    const page1 = await callPage({ assignedAgentId: agentX.id, departmentId: deptA.id, pageSize: "20", page: "1" });
    const page2 = await callPage({ assignedAgentId: agentX.id, departmentId: deptA.id, pageSize: "20", page: "2" });
    check("Page 1 (pageSize=20) returns a full page of 20, still scoped to the SAME assignee+department filter", page1.ids.length === 20 && page1.ids.every((id) => [t1.id, t5.id, ...extraAgentXTickets].includes(id)));
    check("Page 2 returns the 21st ticket — same assignee filter, different page, no overlap with page 1", page2.ids.length === 1 && !page1.ids.includes(page2.ids[0]) && [t1.id, t5.id, ...extraAgentXTickets].includes(page2.ids[0]));
    check("Both pages report the SAME filtered totalCount (21), independent of page", page1.totalCount === 21 && page2.totalCount === 21);

    const filtersSrc = await fs.readFile("components/tickets/ticket-filters.tsx", "utf8");
    check("Changing assignedAgentId resets pagination to page 1: handleSelect -> push() -> the SAME generic params.delete(\"page\") every other filter already uses (no special-cased exemption)", /const handleSelect = \(key: string, value: string\) => \{\s*push\(\{ \[key\]: value === "all" \? null : value \}\);/.test(filtersSrc) && /params\.delete\("page"\);/.test(filtersSrc));
    check("Clearing it (selecting \"All assignees\") removes ONLY assignedAgentId, via the same generic { [key]: null } path — no other param is touched", /value === "all" \? null : value/.test(filtersSrc));
    check("assignedAgentId participates in the SAME activeFilterCount / hasAnyFilter accounting as every other filter (no bespoke reset path)", /get\("assignedAgentId"\)/.test(filtersSrc));

    console.log("\n=== Label wording ===\n");
    check("Dropdown label is exactly \"Assigned to\"", /<Label className="text-xs text-muted-foreground">Assigned to<\/Label>/.test(filtersSrc));
    check("Default option is exactly \"All assignees\" (both the placeholder and the \"all\" SelectItem)", (filtersSrc.match(/All assignees/g) ?? []).length >= 2);
    check("No leftover \"Agent\"/\"Any agent\" wording for this control", !/>Agent<\/Label>/.test(filtersSrc) && !/Any agent/.test(filtersSrc));

    console.log("\n=== 11. Invalid/unauthorized assignee id grants NO additional visibility ===\n");
    currentSession = { user: { id: deptAOnlyViewer.id, role: Role.USER, customRoleId: null } };
    const scopedByAgentX = await callPage({ assignedAgentId: agentX.id, pageSize: "100" });
    check("Dept-A-only viewer + assignedAgentId=agentX -> sees t1 (their own department)", scopedByAgentX.ids.includes(t1.id));
    check("...NEVER sees t4 (department B) despite it matching the same assignee — the department scope AND still applies", !scopedByAgentX.ids.includes(t4.id));

    const garbageId = `nonexistent-user-${RUN_ID}`;
    const garbage = await callPage({ assignedAgentId: garbageId });
    check("A non-existent assignee id -> zero rows, no error, no widened visibility", garbage.ids.length === 0);

    const otherRealUserNotAssignedAnywhere = await prisma.user.create({ data: { email: `assignee-filter-nobody-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(otherRealUserNotAssignedAnywhere.id);
    const realButUnrelated = await callPage({ assignedAgentId: otherRealUserNotAssignedAnywhere.id });
    check("A real user id who owns no tickets anywhere -> zero rows (never falls back to \"show everything\")", realButUnrelated.ids.length === 0);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    console.log("\n=== Server-authoritative filtering: the where-clause condition, not client-side ===\n");
    const pageSrc = await fs.readFile("app/(main)/tickets/page.tsx", "utf8");
    check("assignedAgentId is applied as a real Prisma where-clause AND condition (server-authoritative)", /andConditions\.push\(\{ assignedAgentId: params\.assignedAgentId \}\)/.test(pageSrc));
    check("...ANDed onto the SAME department-scope condition (`scope`) every other filter is, never a separate/looser query", /const andConditions: any\[\] = \[scope,/.test(pageSrc));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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
