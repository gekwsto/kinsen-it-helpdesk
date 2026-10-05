/**
 * Ticket list department/workspace scoping — history and current behavior.
 *
 * ORIGINAL bug this file protected against (2026, prior task): a "Phase 2B"
 * version of app/(main)/tickets/page.tsx substituted the active workspace
 * department into the scope whenever no explicit ?departmentId= was
 * present, and TicketListLiveRefresh's router.refresh() re-ran that
 * substitution on every realtime event — so "All Tickets" could silently
 * collapse to one department at unpredictable moments. The fix at the time
 * removed the substitution entirely: only an explicit ?departmentId= ever
 * narrowed the list; an absent one always meant the full accessible union,
 * regardless of the active workspace.
 *
 * CURRENT behavior (this task — workspace-scoping audit, confirmed with the
 * user): that "never substitute" rule is intentionally REVERSED. The list's
 * scope is now
 *   params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId)
 * — the SAME precedence rule app/(main)/projects/page.tsx and
 * app/(main)/activities/page.tsx already used. An explicit ?departmentId=
 * still wins outright; absent one, the list now DOES follow the active
 * workspace (switching workspace actually re-scopes "All Tickets", which
 * is the reported bug this task fixes); "All Workspaces" (only reachable
 * by a canViewAllDepartments role — ADMIN/DIRECTOR) is the one way left to
 * see the full union on demand. A plain multi-department USER (the
 * `multiUser` fixture below) can no longer see every department's tickets
 * at once on this page without switching between them one at a time — an
 * accepted, explicitly-confirmed tradeoff, not an oversight.
 *
 * The live-refresh robustness THIS file original proved (a background
 * refresh must never silently change what's visible) still holds: scope is
 * a pure function of (cookie, URL params) — a refresh that changes
 * neither reproduces the exact same scope, never a surprise collapse.
 *
 * Exercises the REAL app/(main)/tickets/page.tsx and
 * app/(main)/tickets/closed/page.tsx Server Component functions directly
 * (mocked @/lib/auth + next/headers cookies()), same established pattern as
 * scripts/test-ticket-status-filter-determinism.ts — never a
 * reimplementation of the scope logic.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-list-department-scope-regression.ts
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

const RUN_ID = Date.now();

let currentSession: { user: { id: string; role: any; customRoleId: string | null } } | null = null;
let currentCookieValue: string | undefined = undefined;

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
  const { Role, DepartmentRole, MembershipSource, AuthProvider, RoleScope } = await import("@prisma/client");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { ALL_WORKSPACES_VALUE } = await import("@/types/department");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(0);
  }

  // Dynamically imported so the next/headers mock above is registered
  // before any transitive static import resolves the real cookies().
  const { default: AllTicketsPage } = await import("@/app/(main)/tickets/page");
  const { default: ClosedTicketsPage } = await import("@/app/(main)/tickets/closed/page");
  const { default: AssignedToMePage } = await import("@/app/(main)/tickets/assigned-to-me/page");
  const { TicketTable } = await import("@/components/tickets/ticket-table");
  const { ChooseWorkspaceState } = await import("@/components/workspace/workspace-gate");

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];
  const customRoleKeys: string[] = [];

  type ListResult = { ids: string[]; total: number; pageSize?: number; isGate: boolean; redirectTo?: string };
  async function callPage(page: (args: { searchParams: Promise<Record<string, string>> }) => Promise<any>, params: Record<string, string>): Promise<ListResult> {
    try {
      const element = await page({ searchParams: Promise.resolve(params) });
      const [gateEl] = findElementsByType(element, ChooseWorkspaceState);
      if (gateEl) return { ids: [], total: 0, isGate: true };
      const [tableEl] = findElementsByType(element, TicketTable);
      const tickets = (tableEl?.props.tickets as any[]) ?? [];
      return { ids: tickets.map((t) => t.id), total: tableEl?.props.pagination?.totalCount ?? 0, pageSize: tableEl?.props.pagination?.pageSize, isGate: false };
    } catch (err: any) {
      if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
        return { ids: [], total: 0, isGate: false, redirectTo: err.digest.split(";")[2] ?? "" };
      }
      throw err;
    }
  }

  try {
    // ══════════════ Fixtures ══════════════
    const deptA = await createDepartment({ name: `Scope Regression Finance ${RUN_ID}`, slug: `scope-regr-finance-${RUN_ID}` });
    const deptB = await createDepartment({ name: `Scope Regression IT ${RUN_ID}`, slug: `scope-regr-it-${RUN_ID}` });
    const deptC = await createDepartment({ name: `Scope Regression HR ${RUN_ID}`, slug: `scope-regr-hr-${RUN_ID}` });
    const deptD = await createDepartment({ name: `Scope Regression Unauthorized D ${RUN_ID}`, slug: `scope-regr-d-${RUN_ID}` });
    departmentIds.push(deptA.id, deptB.id, deptC.id, deptD.id);

    const [statusA, statusB, statusC, statusD] = await Promise.all(
      [deptA, deptB, deptC, deptD].map((d) => prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: d.id, isDefault: true } }))
    );

    const requester = await prisma.user.create({ data: { email: `scope-regr-requester-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id);

    // multiUser: real DepartmentMembership (full-view, AGENT_ASSIGNEE —
    // grants ticket.view.all) in A, B, C, with A marked PRIMARY. A plain
    // USER (never canViewAllDepartments) — this is exactly the user whose
    // default "All Tickets" view now follows their active workspace
    // instead of showing every department's tickets at once.
    const multiUser = await prisma.user.create({ data: { email: `scope-regr-multi-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(multiUser.id);
    for (const [dept, isPrimary] of [[deptA, true], [deptB, false], [deptC, false]] as const) {
      const m = await prisma.departmentMembership.create({
        data: { userId: multiUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary, isActive: true },
      });
      membershipIds.push(m.id);
    }

    // noPrimaryUser: member of A, B, C too, but with NO primary at all —
    // resolveActiveWorkspace then leaves departmentId genuinely null
    // (ambiguous, "needs to choose"), which — since Tickets has no
    // dedicated ChooseWorkspaceState gate of its own — falls through to
    // effectiveDepartmentId === null, which buildTicketListWhere treats as
    // "no narrowing," i.e. still the full accessible union. A real,
    // deliberate fallback for this one ambiguous edge case, not a bug.
    const noPrimaryUser = await prisma.user.create({ data: { email: `scope-regr-noprimary-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(noPrimaryUser.id);
    for (const dept of [deptA, deptB, deptC]) {
      const m = await prisma.departmentMembership.create({
        data: { userId: noPrimaryUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: false, isActive: true },
      });
      membershipIds.push(m.id);
    }

    // singleUser (CASE C): member of A only.
    const singleUser = await prisma.user.create({ data: { email: `scope-regr-single-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(singleUser.id);
    const singleMembership = await prisma.departmentMembership.create({
      data: { userId: singleUser.id, departmentId: deptA.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(singleMembership.id);

    // directorUser: canViewAllDepartments — the one role that can actually
    // select "All Workspaces" and reach the true cross-department union.
    const directorUser = await prisma.user.create({ data: { email: `scope-regr-director-${RUN_ID}@kinsen.gr`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(directorUser.id);

    // Seed initial tickets in A, B, C (never D).
    const seedTicket = async (dept: { id: string }, status: { id: string }, title: string) => {
      const t = await prisma.ticket.create({ data: { title, description: "seed", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: status.id } });
      ticketIds.push(t.id);
      return t;
    };
    const ticketA1 = await seedTicket(deptA, statusA, `Finance seed ticket ${RUN_ID}`);
    const ticketB1 = await seedTicket(deptB, statusB, `IT seed ticket ${RUN_ID}`);
    const ticketC1 = await seedTicket(deptC, statusC, `HR seed ticket ${RUN_ID}`);

    // ══════════════ CASE A: multi-department user — no explicit filter now follows the active workspace ══════════════
    console.log("\n=== CASE A: no explicit department filter -> scoped to the active workspace, switches when it switches ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id;
    const workspaceA = await callPage(AllTicketsPage, {});
    check("Workspace A, no filter: not gated", !workspaceA.isGate);
    check("Workspace A, no filter: includes the Finance (A) seed ticket", workspaceA.ids.includes(ticketA1.id));
    check("Workspace A, no filter: excludes the IT (B) seed ticket — the reported bug, now fixed", !workspaceA.ids.includes(ticketB1.id));
    check("Workspace A, no filter: excludes the HR (C) seed ticket", !workspaceA.ids.includes(ticketC1.id));

    // A new ticket arrives in IT (B) — simulating "another session creates
    // a ticket", exactly the live-refresh trigger that used to matter here.
    const ticketB2 = await seedTicket(deptB, statusB, `IT NEW live ticket ${RUN_ID}`);

    // Simulates router.refresh() with the SAME cookie/searchParams (an
    // unrelated background refresh must reproduce the identical scope —
    // never a surprise change just because something else happened).
    const workspaceAAfterRefresh = await callPage(AllTicketsPage, {});
    check("A live refresh with the SAME workspace reproduces the IDENTICAL scope — Finance ticket still present", workspaceAAfterRefresh.ids.includes(ticketA1.id));
    check("...IT's new ticket still correctly excluded (workspace didn't change, so scope didn't either)", !workspaceAAfterRefresh.ids.includes(ticketB2.id));

    // Switching the active workspace (simulating the real workspace
    // switcher + router.refresh()) DOES change the result set now.
    currentCookieValue = deptB.id;
    const workspaceB = await callPage(AllTicketsPage, {});
    check("Switching to Workspace B: IT's tickets (including the live one) now visible", workspaceB.ids.includes(ticketB1.id) && workspaceB.ids.includes(ticketB2.id));
    check("Switching to Workspace B: Finance (A) is no longer visible", !workspaceB.ids.includes(ticketA1.id));

    currentCookieValue = deptC.id;
    const workspaceC = await callPage(AllTicketsPage, {});
    check("Switching to Workspace C: HR's ticket visible, A and B excluded", workspaceC.ids.includes(ticketC1.id) && !workspaceC.ids.includes(ticketA1.id) && !workspaceC.ids.includes(ticketB1.id));

    // A plain multi-department USER (never canViewAllDepartments) has no
    // "All Workspaces" option at all — this is the accepted tradeoff of
    // the new default-to-workspace behavior, confirmed with the user.
    const multiUserFlags = await (await import("@/lib/services/workspace-service")).resolveActiveWorkspace(multiUser.id, Role.USER, deptA.id);
    check("A plain multi-department USER never gets canViewAllDepartments — 'All Workspaces' genuinely isn't an option for them", multiUserFlags.canViewAllDepartments === false && multiUserFlags.isAllSelected === false);

    // The full union remains reachable — just now via "All Workspaces"
    // (canViewAllDepartments roles only), not as the silent default.
    currentSession = { user: { id: directorUser.id, role: Role.DIRECTOR, customRoleId: null } };
    currentCookieValue = ALL_WORKSPACES_VALUE;
    const allWorkspacesUnion = await callPage(AllTicketsPage, {});
    check("'All Workspaces' (DIRECTOR): sees A, B, AND C all at once — the union is still reachable on demand, never removed", allWorkspacesUnion.ids.includes(ticketA1.id) && allWorkspacesUnion.ids.includes(ticketB1.id) && allWorkspacesUnion.ids.includes(ticketC1.id));

    // The OTHER ambiguous path: a multi-department user with NO primary at
    // all and no cookie set — falls back to the full union (see this
    // fixture's own doc comment above), never a crash, never gated.
    currentSession = { user: { id: noPrimaryUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = undefined;
    const noPrimaryResult = await callPage(AllTicketsPage, {});
    check("A multi-department user with NO primary membership and no cookie is NOT gated into ChooseWorkspaceState", !noPrimaryResult.isGate);
    check("...and falls back to the full A+B+C union (ambiguous workspace -> no narrowing, not an error)", noPrimaryResult.ids.includes(ticketA1.id) && noPrimaryResult.ids.includes(ticketB1.id) && noPrimaryResult.ids.includes(ticketC1.id));

    // ══════════════ CASE B: explicit Department=IT ALWAYS wins, regardless of active workspace ══════════════
    console.log("\n=== CASE B: explicit ?departmentId=IT overrides the active workspace, and stays narrowed across a live refresh ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id; // active workspace is Finance — explicit filter must still win
    const explicitBefore = await callPage(AllTicketsPage, { departmentId: deptB.id });
    check("Explicit departmentId=B wins over active Workspace A: includes B's tickets", explicitBefore.ids.includes(ticketB1.id) && explicitBefore.ids.includes(ticketB2.id));
    check("Explicit departmentId=B: excludes A even though A is the active workspace", !explicitBefore.ids.includes(ticketA1.id));
    check("Explicit departmentId=B: excludes C", !explicitBefore.ids.includes(ticketC1.id));

    const ticketC2 = await seedTicket(deptC, statusC, `HR NEW live ticket ${RUN_ID}`);
    const explicitAfterCChange = await callPage(AllTicketsPage, { departmentId: deptB.id });
    check("Explicit departmentId=B is UNAFFECTED by a brand-new HR (C) ticket — the new C ticket never appears here", !explicitAfterCChange.ids.includes(ticketC2.id));

    // ══════════════ CASE D: a ticket in an UNAUTHORIZED department never appears, under any scope ══════════════
    console.log("\n=== CASE D: a ticket in a department the user cannot see remains absent, workspace-scoped or not ===\n");
    const ticketD1 = await seedTicket(deptD, statusD, `Unauthorized D ticket ${RUN_ID}`);
    currentCookieValue = ALL_WORKSPACES_VALUE;
    currentSession = { user: { id: directorUser.id, role: Role.DIRECTOR, customRoleId: null } };
    const allWorkspacesAfterD = await callPage(AllTicketsPage, {});
    check("Department D's ticket DOES appear for a real canViewAllDepartments DIRECTOR in All Workspaces mode (correct — D is a real, active department)", allWorkspacesAfterD.ids.includes(ticketD1.id));
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id;
    const multiUserScopedResult = await callPage(AllTicketsPage, {});
    check("Department D's ticket never appears for multiUser (no membership there), regardless of their own active workspace", !multiUserScopedResult.ids.includes(ticketD1.id));
    const explicitDAttempt = await callPage(AllTicketsPage, { departmentId: deptD.id });
    check("...and an explicit attempt to filter to D is denied outright (redirect/deny), never silently returns D's data", explicitDAttempt.redirectTo !== undefined || explicitDAttempt.ids.length === 0);

    // ══════════════ CASE C: single-department user — naturally and always scoped to their one department ══════════════
    console.log("\n=== CASE C: single-department user naturally resolves to their one department (unchanged by this task) ===\n");
    currentSession = { user: { id: singleUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = undefined;
    const singleResult = await callPage(AllTicketsPage, {});
    check("Single-department user is not gated", !singleResult.isGate);
    check("...sees Finance (A)'s tickets", singleResult.ids.includes(ticketA1.id));
    check("...does NOT see IT (B) or HR (C) (genuinely not a member there)", !singleResult.ids.includes(ticketB1.id) && !singleResult.ids.includes(ticketC1.id));

    // ══════════════ CASE E: explicit filters (search, pageSize) compose correctly with the workspace-scoped default ══════════════
    console.log("\n=== CASE E: explicit filters (search, pageSize) compose correctly with the now-workspace-scoped default ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptB.id; // active workspace: IT
    const searchResult = await callPage(AllTicketsPage, { search: `IT NEW live ticket ${RUN_ID}` });
    check("A search term narrows the (now IT-workspace-scoped) result to just the matching ticket", searchResult.ids.length === 1 && searchResult.ids[0] === ticketB2.id);
    const pageSizeResult = await callPage(AllTicketsPage, { pageSize: "20" });
    check("An explicit valid pageSize (20 — the smallest allowed option) is preserved in the pagination metadata", pageSizeResult.pageSize === 20);
    check("...while the total count reflects the WORKSPACE-scoped total (2: IT's seed + live ticket), not the old full-union count", pageSizeResult.total === 2);

    // Explicit department filter still composes with search too, same as before.
    const explicitPlusSearch = await callPage(AllTicketsPage, { departmentId: deptC.id, search: `HR seed ticket ${RUN_ID}` });
    check("An explicit department filter + search still compose correctly together", explicitPlusSearch.ids.length === 1 && explicitPlusSearch.ids[0] === ticketC1.id);

    // ══════════════ Closed Tickets: identical precedence rule now applies there too ══════════════
    console.log("\n=== app/(main)/tickets/closed/page.tsx: same workspace-vs-explicit-filter precedence as the main Tickets page ===\n");
    // ticket.closed.view is ADMIN-only by default (no built-in DepartmentRole
    // grants it) — a dedicated department-scoped custom role gives a
    // genuinely non-admin, multi-department user real closed-ticket
    // visibility in A and B.
    const closedViewRole = await prisma.customRole.create({
      data: { key: `SCOPE_REGR_CLOSED_VIEW_${RUN_ID}`, name: `Scope Regression Closed View ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.DEPARTMENT, isActive: true },
    });
    customRoleIds.push(closedViewRole.id);
    customRoleKeys.push(closedViewRole.key);
    const closedViewPerms = await prisma.permission.findMany({ where: { key: { in: ["ticket.view", "ticket.view.all", "ticket.closed.view"] } } });
    await prisma.rolePermission.createMany({ data: closedViewPerms.map((p) => ({ roleKey: closedViewRole.key, permissionId: p.id })) });

    const closedUser = await prisma.user.create({ data: { email: `scope-regr-closed-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(closedUser.id);
    for (const [dept, isPrimary] of [[deptA, true], [deptB, false]] as const) {
      const m = await prisma.departmentMembership.create({
        data: { userId: closedUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, customRoleId: closedViewRole.id, source: MembershipSource.MANUAL, isPrimary, isActive: true },
      });
      membershipIds.push(m.id);
    }
    currentSession = { user: { id: closedUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = deptA.id;

    const closedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isClosed: true } });
    const closedStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isClosed: true } });
    const closedA1 = await prisma.ticket.create({ data: { title: `Closed Finance ${RUN_ID}`, description: "d", source: "WEB", requesterId: requester.id, departmentId: deptA.id, statusId: closedStatusA.id, closedAt: new Date() } });
    ticketIds.push(closedA1.id);
    const closedB1 = await prisma.ticket.create({ data: { title: `Closed IT NEW ${RUN_ID}`, description: "d", source: "WEB", requesterId: requester.id, departmentId: deptB.id, statusId: closedStatusB.id, closedAt: new Date() } });
    ticketIds.push(closedB1.id);

    const closedWorkspaceA = await callPage(ClosedTicketsPage, {});
    check("Closed Tickets, Workspace A, no filter: not gated", !closedWorkspaceA.isGate && !closedWorkspaceA.redirectTo);
    check("Closed Tickets, Workspace A: includes Finance's closed ticket", closedWorkspaceA.ids.includes(closedA1.id));
    check("Closed Tickets, Workspace A: excludes IT's closed ticket — same workspace default as the main Tickets page", !closedWorkspaceA.ids.includes(closedB1.id));

    currentCookieValue = deptB.id;
    const closedWorkspaceB = await callPage(ClosedTicketsPage, {});
    check("Closed Tickets, switching to Workspace B: IT's closed ticket now visible, Finance's excluded", closedWorkspaceB.ids.includes(closedB1.id) && !closedWorkspaceB.ids.includes(closedA1.id));

    // ══════════════ Verify Assigned to Me does NOT gain similar implicit narrowing (already correct — confirm, don't change) ══════════════
    console.log("\n=== Assigned to Me: confirm it is STILL not department/workspace-scoped at all — no code change there, no regression ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    const assignedTicket = await prisma.ticket.create({
      data: { title: `Assigned to multiUser in IT ${RUN_ID}`, description: "d", source: "WEB", requesterId: requester.id, departmentId: deptB.id, statusId: statusB.id, assignedAgentId: multiUser.id },
    });
    ticketIds.push(assignedTicket.id);
    currentCookieValue = deptA.id; // active workspace deliberately set to a DIFFERENT department than the assignment
    const assignedResult = await callPage(AssignedToMePage, {});
    check("Assigned to Me shows a ticket assigned in IT (B) even though the active workspace cookie is set to Finance (A) — this page was never department-scoped by workspace, and this task did not change that", assignedResult.ids.includes(assignedTicket.id));
    currentCookieValue = undefined;
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.rolePermission.deleteMany({ where: { roleKey: { in: customRoleKeys } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
