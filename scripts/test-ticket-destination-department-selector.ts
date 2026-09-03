/**
 * Reproduces the reported production defect (New Ticket page showing
 * Workspace/Category/Priority but NO Department field) and proves the fix:
 * a ticket's destination department must be selectable from EVERY active
 * department in the org, never narrowed to departments the REQUESTER
 * happens to hold DepartmentMembership + ticket.create in.
 *
 * Root cause (reproduced in §1 below): the New Ticket page used to source
 * the Department dropdown's options from
 * getAccessibleDepartmentSummaries(userId, role, "ticket.create") — a
 * MEMBERSHIP-scoped helper (correctly still used for project.create/
 * activity.create, where operating inside the department genuinely is
 * required) — and the form hid the dropdown entirely whenever that list had
 * length <= 1. A user who is a DepartmentMembership member of exactly ONE
 * department (e.g. "Systems Operations") — the common case for a non-admin
 * requester — got exactly that: a hidden Department field with only
 * Category/Priority visible, even in an organization with many other real
 * departments.
 *
 * Fix: the Department dropdown now always renders, and its options come
 * from getTicketDestinationDepartments() (every ACTIVE department in the
 * org — the same listDepartments() source of truth already used for
 * ADMIN/DIRECTOR's "every department" case) — not the requester's own
 * memberships. POST /api/tickets now authorizes via
 * resolveTicketDestinationDepartment, which independently checks (a) the
 * requester can create tickets AT ALL (department-scoped ticket.create
 * ANYWHERE, or global) and (b) the destination department is real/active —
 * never requiring membership in the specific destination chosen.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-ticket-destination-department-selector.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, DepartmentRole, MembershipSource, AuthProvider, RoleScope } from "@prisma/client";
import { ensureStatusForDepartment, ensureCategoryForDepartment, STARTER_STATUSES } from "@/lib/services/config-starter-data";
// Deliberately NOT a static top-level import — department-scope-service.ts
// transitively imports lib/permissions.ts -> lib/auth.ts. A static import
// here would evaluate that whole chain (caching the REAL auth()) before
// mock.module("@/lib/auth", ...) below ever registers, making every
// dynamically-imported route handler's requireAuth() silently use the real,
// unmocked auth chain too (same pitfall documented in
// scripts/test-ticket-config-ownership-integrity.ts) — imported dynamically
// inside main(), after both mocks are registered, instead.

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

const RUN_ID = Date.now();

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    handlers: {},
    signIn: async () => {},
    signOut: async () => {},
  },
});

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} },
  });

  const { getAccessibleDepartmentSummaries, getTicketDestinationDepartments, resolveTicketDestinationDepartment } = await import(
    "@/lib/services/department-scope-service"
  );

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(0);
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const membershipIds: string[] = [];
  const customRoleIds: string[] = [];

  try {
    // Mirrors production: an org with several real departments, most of
    // which this particular requester has no relationship with at all.
    const deptSystemsOps = await prisma.department.create({ data: { name: `Systems Operations ${RUN_ID}`, slug: `systems-ops-${RUN_ID}` } });
    const deptIT = await prisma.department.create({ data: { name: `IT ${RUN_ID}`, slug: `it-${RUN_ID}` } });
    const deptFinance = await prisma.department.create({ data: { name: `Finance ${RUN_ID}`, slug: `finance-${RUN_ID}` } });
    departmentIds.push(deptSystemsOps.id, deptIT.id, deptFinance.id);
    await Promise.all([
      ensureStatusForDepartment(prisma, deptSystemsOps.id, STARTER_STATUSES[0]),
      ensureStatusForDepartment(prisma, deptIT.id, STARTER_STATUSES[0]),
      ensureStatusForDepartment(prisma, deptFinance.id, STARTER_STATUSES[0]),
    ]);
    const itCategory = await ensureCategoryForDepartment(prisma, deptIT.id, { name: "Hardware Request", description: null, color: "#6366f1" });
    const financeCategory = await ensureCategoryForDepartment(prisma, deptFinance.id, { name: "Expense Report", description: null, color: "#22c55e" });

    // The exact reported user shape: a plain requester whose ONLY
    // DepartmentMembership (with ticket.create) is Systems Operations.
    const systemsOpsUser = await prisma.user.create({ data: { email: `sysops-user-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(systemsOpsUser.id);
    const sysOpsMembership = await prisma.departmentMembership.create({
      data: { userId: systemsOpsUser.id, departmentId: deptSystemsOps.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(sysOpsMembership.id);

    // ══════════════ 1. Root cause reproduction ══════════════
    console.log("\n=== 1. Root cause: membership-scoped helper vs. destination-department helper ===\n");
    const membershipScoped = await getAccessibleDepartmentSummaries(systemsOpsUser.id, Role.USER, "ticket.create");
    check(
      "getAccessibleDepartmentSummaries(userId, role, 'ticket.create') returns ONLY the user's own department (length 1) — this is EXACTLY why the old dropdown hid itself for this user",
      membershipScoped.length === 1 && membershipScoped[0]?.id === deptSystemsOps.id
    );

    const destinationList = await getTicketDestinationDepartments();
    const destinationIdsThisRun = destinationList.filter((d) => departmentIds.includes(d.id));
    check(
      "getTicketDestinationDepartments() returns ALL active departments in the org (at least the 3 fixture departments), regardless of the requester's own membership",
      destinationIdsThisRun.length === 3
    );
    check("...including IT and Finance, which systemsOpsUser has NO membership in at all", destinationIdsThisRun.some((d) => d.id === deptIT.id) && destinationIdsThisRun.some((d) => d.id === deptFinance.id));

    // ══════════════ 2. Finance user addresses a ticket to IT without IT membership ══════════════
    console.log("\n=== 2. Finance user can submit a ticket addressed to IT without becoming an IT member ===\n");
    const financeUser = await prisma.user.create({ data: { email: `finance-user-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(financeUser.id);
    const financeMembership = await prisma.departmentMembership.create({
      data: { userId: financeUser.id, departmentId: deptFinance.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(financeMembership.id);

    const financeMembershipInIT = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: financeUser.id, departmentId: deptIT.id } } });
    check("Fixture: Finance user has NO DepartmentMembership row in IT at all", financeMembershipInIT === null);

    currentSession = { user: { id: financeUser.id, role: Role.USER, customRoleId: null } };
    const { POST, GET } = await import("@/app/api/tickets/route");
    const financeToITRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "My laptop won't turn on",
          description: "Addressed to IT even though I'm a Finance user with zero IT membership.",
          departmentId: deptIT.id,
          categoryId: itCategory.id,
        }),
      })
    );
    check("Finance user's POST addressed to IT -> 201 (not 403)", financeToITRes.status === 201);
    const financeToITBody = await financeToITRes.json();
    if (financeToITBody?.id) ticketIds.push(financeToITBody.id);
    check("Ticket.departmentId (the ACTUAL owning department column) is IT — the real destination, not Finance", financeToITBody.departmentId === deptIT.id);
    check("IT's own category was accepted (validateTicketConfigOwnership still runs, just against the resolved destination, not the requester's membership)", financeToITBody.categoryId === itCategory.id);

    const financeMembershipInITAfter = await prisma.departmentMembership.findUnique({ where: { userId_departmentId: { userId: financeUser.id, departmentId: deptIT.id } } });
    check("Finance user STILL has no DepartmentMembership in IT after submitting — addressing a ticket never grants membership", financeMembershipInITAfter === null);

    // ══════════════ 3. Resulting visibility follows the EXISTING, unchanged DepartmentMembership/buildTicketListWhere architecture ══════════════
    console.log("\n=== 3. Agent visibility of the IT-destination ticket is unchanged — governed by IT's own DepartmentMembership, not the requester's ===\n");
    const itAgent = await prisma.user.create({ data: { email: `it-agent-${RUN_ID}@kinsen.gr`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(itAgent.id);
    const itAgentMembership = await prisma.departmentMembership.create({
      data: { userId: itAgent.id, departmentId: deptIT.id, role: DepartmentRole.AGENT_ASSIGNEE, source: MembershipSource.MANUAL, isPrimary: true, isActive: true },
    });
    membershipIds.push(itAgentMembership.id);

    currentSession = { user: { id: itAgent.id, role: Role.USER, customRoleId: null } };
    const itAgentListRes = await GET(new NextRequest(`http://localhost/api/tickets?departmentId=${deptIT.id}`));
    check("IT agent's GET /api/tickets?departmentId=IT -> 200", itAgentListRes.status === 200);
    const itAgentList = await itAgentListRes.json();
    check("IT agent sees the Finance-submitted, IT-destined ticket", itAgentList.tickets?.some((t: any) => t.id === financeToITBody.id));

    // An unrelated department's agent (Systems Operations) still cannot see it.
    currentSession = { user: { id: systemsOpsUser.id, role: Role.USER, customRoleId: null } };
    const sysOpsListRes = await GET(new NextRequest(`http://localhost/api/tickets?departmentId=${deptIT.id}`));
    check("Systems Operations user has no membership in IT -> GET ?departmentId=IT is denied (403), not a silently-empty allowed list", sysOpsListRes.status === 403);
    const sysOpsOwnListRes = await GET(new NextRequest("http://localhost/api/tickets"));
    const sysOpsOwnList = await sysOpsOwnListRes.json();
    check("Systems Operations user's own (unfiltered) ticket list never includes the IT ticket either — no cross-department leak", !sysOpsOwnList.tickets?.some((t: any) => t.id === financeToITBody.id));

    // ══════════════ 4. Still fail-closed: destination must be real and active; requester must be able to create tickets at all ══════════════
    console.log("\n=== 4. Still fail-closed ===\n");
    currentSession = { user: { id: financeUser.id, role: Role.USER, customRoleId: null } };
    const fakeDeptRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Ticket to nowhere", description: "departmentId does not exist at all.", departmentId: "not-a-real-department-id" }),
      })
    );
    check("POST with a nonexistent departmentId is still rejected (not 201)", fakeDeptRes.status !== 201);

    const inactiveDept = await prisma.department.create({ data: { name: `Inactive Dest ${RUN_ID}`, slug: `inactive-dest-${RUN_ID}`, isActive: false } });
    departmentIds.push(inactiveDept.id);
    const inactiveDeptRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Ticket to inactive dept", description: "This department exists but is inactive.", departmentId: inactiveDept.id }),
      })
    );
    check("POST addressed to a real but INACTIVE department is still rejected", inactiveDeptRes.status !== 201);

    // A user with ZERO ticket-creation ability anywhere (no DepartmentMembership
    // at all, AND no global grant) is still denied even for a syntactically
    // valid, active department. The base Role.USER enum grants ticket.create
    // GLOBALLY by default in this app's seed (every plain employee can submit
    // *some* ticket) — so "zero ability" has to be constructed via a
    // restrictive GLOBAL-scope custom role that overrides the base grant
    // entirely (see hasPermission: an active customRoleId's own permission
    // set REPLACES the base enum role's, never unions with it), not merely
    // omitting department membership.
    const restrictedRole = await prisma.customRole.create({
      data: { key: `NO_TICKET_CREATE_${RUN_ID}`, name: `No Ticket Create ${RUN_ID}`, isBuiltIn: false, scope: RoleScope.GLOBAL, isActive: true },
    });
    customRoleIds.push(restrictedRole.id);
    const noPermUser = await prisma.user.create({
      data: { email: `no-ticket-create-${RUN_ID}@kinsen.gr`, role: Role.USER, customRoleId: restrictedRole.id, authProvider: AuthProvider.CREDENTIALS },
    });
    userIds.push(noPermUser.id);
    currentSession = { user: { id: noPermUser.id, role: Role.USER, customRoleId: restrictedRole.id } };
    const noPermRes = await POST(
      new NextRequest("http://localhost/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Should be denied", description: "This user has no ticket.create ability anywhere.", departmentId: deptIT.id }),
      })
    );
    check("A user with NO ticket.create ability anywhere (no membership, no global grant) is denied even for a real/active destination", noPermRes.status !== 201 && noPermRes.status === 403);

    // Direct unit-level proof of the resolver itself, mirroring the above.
    const directDenied = await resolveTicketDestinationDepartment(noPermUser.id, Role.USER, restrictedRole.id, deptIT.id);
    check("resolveTicketDestinationDepartment denies a requester with no ticket-creation ability at all, regardless of the destination", "denied" in directDenied);
    const directAllowed = await resolveTicketDestinationDepartment(financeUser.id, Role.USER, null, deptIT.id);
    check("resolveTicketDestinationDepartment allows Finance -> IT with no membership check on the destination", "departmentId" in directAllowed && directAllowed.departmentId === deptIT.id);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { customRoleId: null } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.customRole.deleteMany({ where: { id: { in: customRoleIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
