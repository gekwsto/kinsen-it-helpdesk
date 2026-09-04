/**
 * Reproduces and proves the fix for the reported "live refresh narrows All
 * Tickets to one department" regression.
 *
 * ROOT CAUSE (confirmed by reading, not assumed): app/(main)/tickets/page.tsx
 * and app/(main)/tickets/closed/page.tsx computed their list's scope as
 *   params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId)
 * — i.e. whenever the URL had no explicit ?departmentId=, the page silently
 * substituted the user's ACTIVE WORKSPACE department (their primary
 * DepartmentMembership, or their sole membership) as the scope. This was a
 * pre-existing "Phase 2B" decision (see the removed code's own comment),
 * NOT something the new live-refresh feature introduced — but
 * TicketListLiveRefresh's router.refresh() re-runs this SAME substitution
 * on every realtime event, so a ticket change in ANY department now
 * visibly collapses "All Tickets" down to whatever the viewer's own active
 * workspace happens to be, on every refresh, instead of remaining the
 * union of every department they're authorized to see.
 *
 * buildTicketListWhere/getTicketFilterOptions already correctly resolve an
 * ABSENT departmentId to the full union of accessible departments (see
 * their own doc comments) — the fix removes the active-workspace
 * substitution entirely; only an EXPLICIT ?departmentId= narrows the list
 * now. activeWorkspace is still consulted only to detect "zero accessible
 * departments at all" (NoWorkspaceState).
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
// The active-workspace cookie — deliberately left `undefined` (no cookie at
// all) for the multi-department scenarios below: "no explicit filter" must
// mean the union regardless of whatever the user's default/primary
// workspace happens to resolve to, so the fix must hold even when a cookie
// IS present and would (under the old code) have supplied a department.
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

    // multiUser: real DepartmentMembership (full-view, AGENT_ASSIGNEE — grants
    // ticket.view.all) in A, B, C, with A marked PRIMARY — the exact shape
    // that used to make the OLD code silently narrow "All Tickets" to A.
    // NOT a member of D at all.
    const multiUser = await prisma.user.create({ data: { email: `scope-regr-multi-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(multiUser.id);
    for (const [dept, isPrimary] of [[deptA, true], [deptB, false], [deptC, false]] as const) {
      const m = await prisma.departmentMembership.create({
        data: { userId: multiUser.id, departmentId: dept.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary, isActive: true },
      });
      membershipIds.push(m.id);
    }

    // noPrimaryUser: member of A, B, C too, but with NO primary at all — the
    // OTHER old-broken path (forced into ChooseWorkspaceState instead of
    // narrowed).
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

    // Seed initial tickets in A, B, C (never D).
    const seedTicket = async (dept: { id: string }, status: { id: string }, title: string) => {
      const t = await prisma.ticket.create({ data: { title, description: "seed", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: status.id } });
      ticketIds.push(t.id);
      return t;
    };
    const ticketA1 = await seedTicket(deptA, statusA, `Finance seed ticket ${RUN_ID}`);
    const ticketB1 = await seedTicket(deptB, statusB, `IT seed ticket ${RUN_ID}`);
    const ticketC1 = await seedTicket(deptC, statusC, `HR seed ticket ${RUN_ID}`);

    // ══════════════ CASE A: multi-department user, All Tickets, NO department filter ══════════════
    console.log("\n=== CASE A: no explicit department filter -> union of A+B+C, never narrowed to the active workspace ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    currentCookieValue = undefined; // no cookie at all — the common case
    const before = await callPage(AllTicketsPage, {});
    check("BEFORE: not gated (no ChooseWorkspaceState)", !before.isGate);
    check("BEFORE: includes the Finance (A) seed ticket", before.ids.includes(ticketA1.id));
    check("BEFORE: includes the IT (B) seed ticket", before.ids.includes(ticketB1.id));
    check("BEFORE: includes the HR (C) seed ticket", before.ids.includes(ticketC1.id));

    // A new ticket arrives in IT (B) — simulating "another session creates a
    // ticket", exactly the live-refresh trigger.
    const ticketB2 = await seedTicket(deptB, statusB, `IT NEW live ticket ${RUN_ID}`);

    // Simulates router.refresh(): re-invoke the SAME page with the
    // IDENTICAL searchParams (never touched by the realtime event, which
    // carries no department data at all).
    const after = await callPage(AllTicketsPage, {});
    check("AFTER refresh: still not gated", !after.isGate);
    check("AFTER refresh: Finance (A) ticket STILL present", after.ids.includes(ticketA1.id));
    check("AFTER refresh: IT (B) seed ticket STILL present", after.ids.includes(ticketB1.id));
    check("AFTER refresh: HR (C) ticket STILL present", after.ids.includes(ticketC1.id));
    check("AFTER refresh: the NEW IT ticket now appears too — A+B+C remains A+B+C, plus the new one", after.ids.includes(ticketB2.id));
    check("AFTER refresh: result set did NOT collapse to IT-only (still includes A and C)", after.ids.length >= 4);

    // Also with an explicit primary-workspace cookie SET to A — the exact
    // condition that used to trigger the substitution — proving the fix
    // holds even when a cookie exists, not just when it's absent.
    currentCookieValue = deptA.id;
    const withCookieSet = await callPage(AllTicketsPage, {});
    check("Even with the active-workspace cookie explicitly set to A, no ?departmentId= still means the FULL union (not narrowed to A)", withCookieSet.ids.includes(ticketA1.id) && withCookieSet.ids.includes(ticketB1.id) && withCookieSet.ids.includes(ticketC1.id) && withCookieSet.ids.includes(ticketB2.id));
    currentCookieValue = undefined;

    // The OTHER old-broken path: a multi-department user with NO primary at
    // all used to be forced into ChooseWorkspaceState instead of seeing
    // anything.
    currentSession = { user: { id: noPrimaryUser.id, role: Role.USER, customRoleId: null } };
    const noPrimaryResult = await callPage(AllTicketsPage, {});
    check("A multi-department user with NO primary membership is NOT gated into ChooseWorkspaceState either", !noPrimaryResult.isGate);
    check("...and also sees the full A+B+C union", noPrimaryResult.ids.includes(ticketA1.id) && noPrimaryResult.ids.includes(ticketB1.id) && noPrimaryResult.ids.includes(ticketC1.id));

    // ══════════════ CASE B: explicit Department=IT stays narrowed, even across a live refresh ══════════════
    console.log("\n=== CASE B: explicit ?departmentId=IT remains narrowed to IT across a live refresh ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    const explicitBefore = await callPage(AllTicketsPage, { departmentId: deptB.id });
    check("Explicit departmentId=B: includes B's tickets", explicitBefore.ids.includes(ticketB1.id) && explicitBefore.ids.includes(ticketB2.id));
    check("Explicit departmentId=B: excludes A", !explicitBefore.ids.includes(ticketA1.id));
    check("Explicit departmentId=B: excludes C", !explicitBefore.ids.includes(ticketC1.id));

    // ══════════════ CASE 3 (brief's own numbering): a change in HR (C) — All Tickets (no filter) still remains A+B+C ══════════════
    const ticketC2 = await seedTicket(deptC, statusC, `HR NEW live ticket ${RUN_ID}`);
    const explicitAfterCChange = await callPage(AllTicketsPage, { departmentId: deptB.id });
    check("Explicit departmentId=B is UNAFFECTED by a brand-new HR (C) ticket — the new C ticket never appears here", !explicitAfterCChange.ids.includes(ticketC2.id));

    const unionAfterCChange = await callPage(AllTicketsPage, {});
    check("No-filter union still includes A+B+C after the new HR ticket too", unionAfterCChange.ids.includes(ticketA1.id) && unionAfterCChange.ids.includes(ticketB1.id) && unionAfterCChange.ids.includes(ticketC1.id) && unionAfterCChange.ids.includes(ticketC2.id));

    // ══════════════ CASE D: a ticket in an UNAUTHORIZED department never appears ══════════════
    console.log("\n=== CASE D: a ticket in a department the user cannot see remains absent after refresh ===\n");
    const ticketD1 = await seedTicket(deptD, statusD, `Unauthorized D ticket ${RUN_ID}`);
    const unionAfterDChange = await callPage(AllTicketsPage, {});
    check("Department D's ticket never appears in the union — multiUser has no membership in D", !unionAfterDChange.ids.includes(ticketD1.id));
    const explicitDAttempt = await callPage(AllTicketsPage, { departmentId: deptD.id });
    check("...and an explicit attempt to filter to D is denied outright (redirect/deny), never silently returns D's data", explicitDAttempt.redirectTo !== undefined || explicitDAttempt.ids.length === 0);

    // ══════════════ CASE C: single-department user — natural single-department scope, unchanged ══════════════
    console.log("\n=== CASE C: single-department user naturally resolves to their one department ===\n");
    currentSession = { user: { id: singleUser.id, role: Role.USER, customRoleId: null } };
    const singleResult = await callPage(AllTicketsPage, {});
    check("Single-department user is not gated", !singleResult.isGate);
    check("...sees Finance (A)'s tickets", singleResult.ids.includes(ticketA1.id));
    check("...does NOT see IT (B) or HR (C) (genuinely not a member there)", !singleResult.ids.includes(ticketB1.id) && !singleResult.ids.includes(ticketC1.id));

    // ══════════════ CASE E: pagination/search filters remain fully respected alongside the union scope ══════════════
    console.log("\n=== CASE E: explicit filters (search, pageSize) remain exactly respected within the union scope ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    const searchResult = await callPage(AllTicketsPage, { search: `IT NEW live ticket ${RUN_ID}` });
    check("A search term narrows the (still-union-scoped) result to just the matching ticket", searchResult.ids.length === 1 && searchResult.ids[0] === ticketB2.id);
    const pageSizeResult = await callPage(AllTicketsPage, { pageSize: "20" });
    check("An explicit valid pageSize (20 — the smallest allowed option) is preserved in the pagination metadata", pageSizeResult.pageSize === 20);
    check("...while the total count still reflects the FULL union scope (5: A1, B1, C1, B2, C2), not narrowed", pageSizeResult.total >= 5);

    // ══════════════ Closed Tickets: identical fix, identical proof (abbreviated) ══════════════
    console.log("\n=== app/(main)/tickets/closed/page.tsx gets the identical fix ===\n");
    // ticket.closed.view is ADMIN-only by default (no built-in DepartmentRole
    // grants it) — a dedicated department-scoped custom role gives a
    // genuinely non-admin, multi-department user real closed-ticket
    // visibility in A and B, so this proof isn't just "ADMIN sees
    // everything anyway" (which would prove nothing about the fix).
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

    const closedStatusA = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptA.id, isClosed: true } });
    const closedStatusB = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptB.id, isClosed: true } });
    const closedA1 = await prisma.ticket.create({ data: { title: `Closed Finance ${RUN_ID}`, description: "d", source: "WEB", requesterId: requester.id, departmentId: deptA.id, statusId: closedStatusA.id, closedAt: new Date() } });
    ticketIds.push(closedA1.id);
    const closedUnionBefore = await callPage(ClosedTicketsPage, {});
    check("Closed Tickets, no filter: not gated", !closedUnionBefore.isGate && !closedUnionBefore.redirectTo);
    check("Closed Tickets, no filter: includes the Finance closed ticket (closedUser's PRIMARY department)", closedUnionBefore.ids.includes(closedA1.id));
    const closedB1 = await prisma.ticket.create({ data: { title: `Closed IT NEW ${RUN_ID}`, description: "d", source: "WEB", requesterId: requester.id, departmentId: deptB.id, statusId: closedStatusB.id, closedAt: new Date() } });
    ticketIds.push(closedB1.id);
    const closedUnionAfter = await callPage(ClosedTicketsPage, {});
    check("Closed Tickets, no filter, after a live refresh: STILL includes Finance's closed ticket AND the new IT one — not narrowed to the primary (Finance)", closedUnionAfter.ids.includes(closedA1.id) && closedUnionAfter.ids.includes(closedB1.id));

    // ══════════════ Verify Assigned to Me does NOT gain similar implicit narrowing (already correct — confirm, don't change) ══════════════
    console.log("\n=== Assigned to Me: confirm it was ALREADY correct (no activeWorkspace narrowing) — no code change needed there ===\n");
    currentSession = { user: { id: multiUser.id, role: Role.USER, customRoleId: null } };
    const assignedTicket = await prisma.ticket.create({
      data: { title: `Assigned to multiUser in IT ${RUN_ID}`, description: "d", source: "WEB", requesterId: requester.id, departmentId: deptB.id, statusId: statusB.id, assignedAgentId: multiUser.id },
    });
    ticketIds.push(assignedTicket.id);
    currentCookieValue = deptA.id; // active workspace deliberately set to a DIFFERENT department than the assignment
    const assignedResult = await callPage(AssignedToMePage, {});
    check("Assigned to Me shows a ticket assigned in IT (B) even though the active workspace cookie is set to Finance (A) — this page was never department-scoped by workspace", assignedResult.ids.includes(assignedTicket.id));
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
