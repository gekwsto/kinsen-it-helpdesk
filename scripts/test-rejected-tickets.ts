/**
 * Regression coverage for the Rejected Tickets workflow
 * (app/(main)/tickets/rejected/page.tsx, the "Create Ticket" recovery
 * action, and the underlying acceptPendingTicket REJECTED->ACCEPTED
 * transition). No second PendingTicket->Ticket mapping was introduced —
 * this exercises the SAME app/api/tickets/pending/[id]/accept route and
 * lib/services/pending-ticket-service.ts the Pending page already uses,
 * plus the exact query shape (buildPendingTicketListWhere + status:
 * REJECTED) the new page's server component runs.
 *
 * Covers the task's own checklist (UI-only points are left to
 * scripts/browser-verify-rejected-tickets.ts):
 *  4/5/6.   The Rejected query returns REJECTED rows only — never PENDING
 *           or ACCEPTED.
 *  7/8/9/10. Sender/subject/department/receivedAfter/receivedBefore
 *           filters all narrow correctly.
 *  16/17/18/19/20/21/22. REJECTED -> "Create Ticket" produces a real
 *           Ticket carrying the ORIGINAL subject/body/requester, the
 *           source becomes ACCEPTED, and it no longer matches the
 *           REJECTED-only query — all through the real HTTP route handler
 *           (mocked auth), not just the service function directly (see
 *           scripts/test-pending-ticket-accept-reject.ts for the
 *           service-level idempotency/concurrency proof).
 *  23.      Unmatched (departmentId: null) rejected records still require
 *           an explicit department at recovery time (same as Accept).
 *  31/32/33/34/35. Permission/department scoping: an authorized reviewer
 *           can list+recover; an unauthorized user cannot list (query
 *           returns nothing) and the route itself rejects a direct
 *           recovery attempt.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-rejected-tickets.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, PendingTicketStatus } from "@prisma/client";
// buildPendingTicketListWhere/ensureStatusForDepartment/ensurePriorityForDepartment
// are dynamically imported INSIDE main(), after mock.module("@/lib/auth", ...)
// below — department-scope-service.ts transitively imports lib/permissions.ts,
// which binds `auth` from "@/lib/auth" at module-evaluation time. A static
// top-level `import` here would be hoisted and evaluated before this file's
// own mock.module() call ever runs, permanently binding the REAL next-auth
// `auth()` into lib/permissions.ts instead of this mock — the exact bug
// that produced a `headers() called outside a request scope` 500 from the
// accept route during this test's own development (see the final report).

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
const TAG = `rjt-${RUN_ID}`;

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
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const realNextServer = await import("next/server");
  mock.module("next/server", { namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} } });
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => {} } });

  const { POST: acceptRoute } = await import("@/app/api/tickets/pending/[id]/accept/route");
  const { POST: rejectRoute } = await import("@/app/api/tickets/pending/[id]/reject/route");
  const { buildPendingTicketListWhere } = await import("@/lib/services/department-scope-service");
  const { ensureStatusForDepartment, ensurePriorityForDepartment, STARTER_STATUSES, STARTER_PRIORITIES } = await import("@/lib/services/config-starter-data");

  const jsonReq = (url: string, body: unknown) =>
    new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const emptyReq = (url: string) => new NextRequest(url, { method: "POST" });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const membershipIds: string[] = [];
  const pendingTicketIds: string[] = [];
  const ticketIds: string[] = [];

  try {
    console.log("\n=== Fixtures: two Departments, a reviewer (ticket.pending.*), a user with no such standing ===\n");
    const deptA = await prisma.department.create({ data: { name: `${TAG}-A`, slug: `${TAG}-a` }, select: { id: true } });
    const deptB = await prisma.department.create({ data: { name: `${TAG}-B`, slug: `${TAG}-b` }, select: { id: true } });
    departmentIds.push(deptA.id, deptB.id);
    await ensureStatusForDepartment(prisma, deptA.id, STARTER_STATUSES[0]);
    await ensurePriorityForDepartment(prisma, deptA.id, STARTER_PRIORITIES[0]);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(admin.id);

    const reviewer = await prisma.user.create({
      data: { email: `${TAG}-reviewer@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(reviewer.id);
    const reviewerMembership = await prisma.departmentMembership.create({
      data: { userId: reviewer.id, departmentId: deptA.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(reviewerMembership.id);

    // REQUESTER: real membership in deptA, but REQUESTER holds NEITHER
    // ticket.pending.view NOR ticket.pending.accept — proves the review
    // capability is checked, not merely "has some standing in the department".
    const outsider = await prisma.user.create({
      data: { email: `${TAG}-outsider@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(outsider.id);
    const outsiderMembership = await prisma.departmentMembership.create({
      data: { userId: outsider.id, departmentId: deptA.id, role: DepartmentRole.REQUESTER, source: MembershipSource.MANUAL },
    });
    membershipIds.push(outsiderMembership.id);

    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };

    // ── Fixtures: PENDING, ACCEPTED, and REJECTED rows in deptA, plus one in deptB ──
    const pendingRow = await prisma.pendingTicket.create({
      data: { emailMessageId: `${TAG}-pending@test.local`, fromEmail: "still-pending@example.com", subject: "Still Pending", body: "<p>x</p>", receivedAt: new Date(), departmentId: deptA.id },
    });
    pendingTicketIds.push(pendingRow.id);

    const acceptedRow = await prisma.pendingTicket.create({
      data: { emailMessageId: `${TAG}-accepted@test.local`, fromEmail: "already-accepted@example.com", subject: "Already Accepted", body: "<p>x</p>", receivedAt: new Date(), departmentId: deptA.id, status: PendingTicketStatus.ACCEPTED, acceptedById: admin.id, acceptedAt: new Date() },
    });
    pendingTicketIds.push(acceptedRow.id);

    const rejectedRow = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `${TAG}-rejected@test.local`,
        fromEmail: `sender-${RUN_ID}@example.com`,
        fromName: "Original Sender",
        subject: `Rejected Request ${RUN_ID}`,
        body: `<p>The full original body for ${RUN_ID}, including <strong>formatting</strong>.</p>`,
        receivedAt: new Date("2026-01-15T10:00:00Z"),
        departmentId: deptA.id,
        status: PendingTicketStatus.REJECTED,
        rejectedById: reviewer.id,
        rejectedAt: new Date(),
      },
    });
    pendingTicketIds.push(rejectedRow.id);

    const rejectedRowDeptB = await prisma.pendingTicket.create({
      data: { emailMessageId: `${TAG}-rejected-b@test.local`, fromEmail: "other-dept@example.com", subject: "Rejected In Dept B", body: "<p>x</p>", receivedAt: new Date(), departmentId: deptB.id, status: PendingTicketStatus.REJECTED, rejectedById: admin.id, rejectedAt: new Date() },
    });
    pendingTicketIds.push(rejectedRowDeptB.id);

    // ── 4/5/6. The Rejected query returns REJECTED only ──
    console.log("\n4/5/6. The Rejected page's own query (buildPendingTicketListWhere + status: REJECTED) returns REJECTED rows only ===\n");
    const adminScope = await buildPendingTicketListWhere(admin.id, Role.ADMIN, undefined);
    if (!("denied" in adminScope)) {
      const rejectedOnly = await prisma.pendingTicket.findMany({
        where: { AND: [adminScope, { status: PendingTicketStatus.REJECTED }, { id: { in: pendingTicketIds } }] },
      });
      check("Includes the REJECTED row in deptA", rejectedOnly.some((r) => r.id === rejectedRow.id));
      check("Includes the REJECTED row in deptB (admin sees all)", rejectedOnly.some((r) => r.id === rejectedRowDeptB.id));
      check("Does NOT include the PENDING row", !rejectedOnly.some((r) => r.id === pendingRow.id));
      check("Does NOT include the ACCEPTED row", !rejectedOnly.some((r) => r.id === acceptedRow.id));
    } else {
      check("Admin scope resolved", false);
    }

    // ── 7/8/9/10. Filters narrow correctly ──
    console.log("\n7/8/9/10. Sender/Subject/Department/receivedAfter/receivedBefore filters narrow the Rejected query correctly ===\n");
    const bySender = await prisma.pendingTicket.findMany({
      where: { AND: [adminScope as Record<string, unknown>, { status: PendingTicketStatus.REJECTED }, { fromEmail: { contains: `sender-${RUN_ID}`, mode: "insensitive" } }] },
    });
    check("Sender filter narrows to exactly the matching REJECTED row", bySender.length === 1 && bySender[0].id === rejectedRow.id);

    const bySubject = await prisma.pendingTicket.findMany({
      where: { AND: [adminScope as Record<string, unknown>, { status: PendingTicketStatus.REJECTED }, { subject: { contains: `Rejected Request ${RUN_ID}`, mode: "insensitive" } }] },
    });
    check("Subject filter narrows to exactly the matching REJECTED row", bySubject.length === 1 && bySubject[0].id === rejectedRow.id);

    const byDept = await prisma.pendingTicket.findMany({
      where: { AND: [adminScope as Record<string, unknown>, { status: PendingTicketStatus.REJECTED }, { id: { in: pendingTicketIds } }, { departmentId: deptA.id }] },
    });
    check("Department filter excludes Department B's rejected row", !byDept.some((r) => r.id === rejectedRowDeptB.id));
    check("Department filter includes Department A's rejected row", byDept.some((r) => r.id === rejectedRow.id));

    const byReceivedAfter = await prisma.pendingTicket.findMany({
      where: { AND: [adminScope as Record<string, unknown>, { status: PendingTicketStatus.REJECTED }, { id: rejectedRow.id }, { receivedAt: { gte: new Date("2026-01-01T00:00:00Z") } }] },
    });
    check("receivedAfter includes a row received after the cutoff", byReceivedAfter.length === 1);
    const byReceivedBeforeExcludes = await prisma.pendingTicket.findMany({
      where: { AND: [adminScope as Record<string, unknown>, { status: PendingTicketStatus.REJECTED }, { id: rejectedRow.id }, { receivedAt: { lte: new Date("2026-01-01T00:00:00Z") } }] },
    });
    check("receivedBefore excludes a row received after the cutoff", byReceivedBeforeExcludes.length === 0);

    // ── 31/32. Permission scoping for listing ──
    console.log("\n31/32. Authorized reviewer can list Rejected; an outsider (no ticket.pending.* standing) cannot ===\n");
    const reviewerScope = await buildPendingTicketListWhere(reviewer.id, Role.USER, deptA.id);
    check("Reviewer's scope resolves (not denied)", !("denied" in reviewerScope));
    if (!("denied" in reviewerScope)) {
      const reviewerVisible = await prisma.pendingTicket.findMany({ where: { AND: [reviewerScope, { status: PendingTicketStatus.REJECTED }, { id: rejectedRow.id }] } });
      check("Reviewer sees the rejected row in their own department", reviewerVisible.length === 1);
    }
    const outsiderScope = await buildPendingTicketListWhere(outsider.id, Role.USER, undefined);
    check(
      "An outsider with real department membership but no ticket.pending.view gets a zero-match scope",
      !("denied" in outsiderScope) && JSON.stringify(outsiderScope).includes('"id":{"in":[]}')
    );

    // ── 16-22. REJECTED -> Create Ticket via the REAL route handler ──
    console.log("\n16-22. \"Create Ticket\" recovers a REJECTED record into a real Ticket via the real accept route ===\n");
    currentSession = { user: { id: reviewer.id, role: Role.USER, customRoleId: null } };
    const recoverRes = await acceptRoute(jsonReq(`http://localhost/api/tickets/pending/${rejectedRow.id}/accept`, {}), { params: Promise.resolve({ id: rejectedRow.id }) });
    const recovered = await recoverRes.json();
    check("Recovering a REJECTED record via the real route -> 200", recoverRes.status === 200, `status=${recoverRes.status} body=${JSON.stringify(recovered)}`);
    ticketIds.push(recovered.id);

    const recoveredTicket = await prisma.ticket.findUnique({ where: { id: recovered.id }, include: { requester: true } });
    check("Recovered Ticket has the ORIGINAL subject as its title", recoveredTicket?.title === rejectedRow.subject);
    check("Recovered Ticket has the ORIGINAL body as its description", recoveredTicket?.description === rejectedRow.body);
    check("Recovered Ticket carries the original emailMessageId (provenance preserved)", recoveredTicket?.emailMessageId === rejectedRow.emailMessageId);
    check("Recovered Ticket resolves a requester from the original sender", recoveredTicket?.requester.email === rejectedRow.fromEmail);
    check("Recovered Ticket is linked to the correct department", recoveredTicket?.departmentId === deptA.id);

    const recoveredMessage = await prisma.ticketMessage.findFirst({ where: { ticketId: recovered.id } });
    check("Recovered Ticket's initial message carries the original fromEmail/fromName", recoveredMessage?.fromEmail === rejectedRow.fromEmail && recoveredMessage?.fromName === rejectedRow.fromName);

    const sourceAfterRecovery = await prisma.pendingTicket.findUnique({ where: { id: rejectedRow.id } });
    check("Source PendingTicket is now ACCEPTED", sourceAfterRecovery?.status === "ACCEPTED");
    check("acceptedTicketId points at the recovered Ticket", sourceAfterRecovery?.acceptedTicketId === recovered.id);
    check("Rejection history (rejectedAt/rejectedById) is preserved, not erased", !!sourceAfterRecovery?.rejectedAt && sourceAfterRecovery?.rejectedById === reviewer.id);

    console.log("\n20. The recovered source no longer matches the Rejected page's own query ===\n");
    const rejectedQueryAfterRecovery = await prisma.pendingTicket.findMany({
      where: { AND: [adminScope as Record<string, unknown>, { status: PendingTicketStatus.REJECTED }, { id: rejectedRow.id }] },
    });
    check("No longer appears in a REJECTED-filtered query", rejectedQueryAfterRecovery.length === 0);

    // ── 23. Unmatched rejected record requires an explicit department ──
    console.log("\n23. An unmatched (departmentId: null) rejected record still requires an explicit department to recover ===\n");
    const unmatchedRejected = await prisma.pendingTicket.create({
      data: { emailMessageId: `${TAG}-unmatched-rejected@test.local`, fromEmail: "unmatched@example.com", subject: "Unmatched Rejected", body: "<p>x</p>", receivedAt: new Date(), departmentId: null, status: PendingTicketStatus.REJECTED, rejectedById: admin.id, rejectedAt: new Date() },
    });
    pendingTicketIds.push(unmatchedRejected.id);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const noDeptRes = await acceptRoute(jsonReq(`http://localhost/api/tickets/pending/${unmatchedRejected.id}/accept`, {}), { params: Promise.resolve({ id: unmatchedRejected.id }) });
    check("Recovering an unmatched rejected record with NO department override -> rejected (400)", noDeptRes.status === 400);
    const withDeptRes = await acceptRoute(jsonReq(`http://localhost/api/tickets/pending/${unmatchedRejected.id}/accept`, { departmentId: deptA.id }), { params: Promise.resolve({ id: unmatchedRejected.id }) });
    check("Recovering the same record WITH an explicit department override -> 200", withDeptRes.status === 200);
    const withDeptBody = await withDeptRes.json();
    ticketIds.push(withDeptBody.id);
    const unmatchedTicket = await prisma.ticket.findUnique({ where: { id: withDeptBody.id } });
    check("The resolved Ticket uses the explicitly chosen department, not a guessed default", unmatchedTicket?.departmentId === deptA.id);

    // ── 34/35. Direct API recovery attempt is rejected for an unauthorized user ──
    console.log("\n34/35. A direct API recovery attempt from an unauthorized user is rejected, department scoping intact ===\n");
    const anotherRejected = await prisma.pendingTicket.create({
      data: { emailMessageId: `${TAG}-blocked@test.local`, fromEmail: "blocked@example.com", subject: "Should Stay Rejected", body: "<p>x</p>", receivedAt: new Date(), departmentId: deptA.id, status: PendingTicketStatus.REJECTED, rejectedById: admin.id, rejectedAt: new Date() },
    });
    pendingTicketIds.push(anotherRejected.id);
    currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: null } };
    const deniedRecoverRes = await acceptRoute(jsonReq(`http://localhost/api/tickets/pending/${anotherRejected.id}/accept`, {}), { params: Promise.resolve({ id: anotherRejected.id }) });
    check("An outsider's direct recovery attempt -> 403", deniedRecoverRes.status === 403);
    const stillRejected = await prisma.pendingTicket.findUnique({ where: { id: anotherRejected.id }, select: { status: true } });
    check("The record is still REJECTED (not silently converted)", stillRejected?.status === "REJECTED");
    const noTicketCreated = await prisma.ticket.findFirst({ where: { emailMessageId: anotherRejected.emailMessageId } });
    check("No Ticket was created by the denied attempt", noTicketCreated === null);

    // Same outsider also cannot reject-again or interfere with a real Reject flow — sanity check the Reject route independently still works for the authorized reviewer.
    console.log("\nSanity: existing Reject flow (from Pending) is completely unaffected ===\n");
    currentSession = { user: { id: reviewer.id, role: Role.USER, customRoleId: null } };
    const rejectRes = await rejectRoute(emptyReq(`http://localhost/api/tickets/pending/${pendingRow.id}/reject`), { params: Promise.resolve({ id: pendingRow.id }) });
    check("Reject from Pending still works exactly as before -> 200", rejectRes.status === 200);
    const nowRejected = await prisma.pendingTicket.findUnique({ where: { id: pendingRow.id }, select: { status: true } });
    check("Pending row is now REJECTED (and would appear on the Rejected page next)", nowRejected?.status === "REJECTED");
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } });
      await prisma.departmentMembership.deleteMany({ where: { id: { in: membershipIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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

main();
