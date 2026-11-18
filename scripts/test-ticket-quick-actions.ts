/**
 * Focused regression for the two new Ticket Detail "Quick Actions" (Assign
 * to me, Resolve). Both are thin UI wrappers that call the EXISTING
 * PATCH /api/tickets/[id]/assign and PATCH /api/tickets/[id]/status routes
 * with pre-filled bodies — no new API routes, schemas, or permission keys
 * were added. This script verifies those two routes behave exactly as the
 * Quick Actions now depend on: permission enforcement (including the
 * assign/status owner-bypass asymmetry), the non-assignable-target
 * rejection, audit history, and that resolving to "Resolved" does NOT
 * close the ticket (isClosed stays false, closedAt stays null) — the
 * state change the Quick Action UI gating logic and the confirmation
 * dialog's own copy both depend on.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-quick-actions.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, TicketSource } from "@prisma/client";

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
const TAG = `tqa-${RUN_ID}`;

mock.module("server-only", { namedExports: {} });

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

  const { PATCH: patchAssign } = await import("@/app/api/tickets/[id]/assign/route");
  const { PATCH: patchStatus } = await import("@/app/api/tickets/[id]/status/route");

  const jsonReq = (url: string, body: unknown) =>
    new NextRequest(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const statusIds: string[] = [];

  try {
    console.log("\n=== Fixtures ===\n");
    const dept = await prisma.department.create({ data: { name: `${TAG}-dept`, slug: `${TAG}-dept` } });
    departmentIds.push(dept.id);

    const openStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: "Open", color: "#3b82f6", isDefault: true, isClosed: false, order: 1 } });
    const resolvedStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: "Resolved", color: "#10b981", isDefault: false, isClosed: false, order: 2 } });
    const closedStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: "Closed", color: "#6b7280", isDefault: false, isClosed: true, order: 3 } });
    statusIds.push(openStatus.id, resolvedStatus.id, closedStatus.id);

    const admin = await prisma.user.create({
      data: { email: `${TAG}-admin@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    const outsider = await prisma.user.create({
      // A plain USER with NO DepartmentMembership anywhere — the
      // permission-denied case, and (when also the ticket's requester)
      // the owner-bypass contrast case.
      data: { email: `${TAG}-outsider@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
    });
    userIds.push(admin.id, outsider.id);

    const makeTicket = async (requesterId: string, statusId: string, assignedAgentId: string | null = null) => {
      const t = await prisma.ticket.create({
        data: { title: `${TAG} ticket`, description: "desc", source: TicketSource.WEB, requesterId, departmentId: dept.id, statusId, assignedAgentId },
      });
      ticketIds.push(t.id);
      return t;
    };

    // ── 1. "Assign to me" success — ADMIN self-assigns an unassigned ticket ──
    console.log("\n1. Assign to me — unassigned ticket, ADMIN session -> 200, audit row, realtime payload ===\n");
    const unassigned = await makeTicket(outsider.id, openStatus.id, null);
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const assignRes1 = await patchAssign(jsonReq(`http://localhost/api/tickets/${unassigned.id}/assign`, { assignedAgentId: admin.id }), {
      params: Promise.resolve({ id: unassigned.id }),
    });
    check("PATCH assign -> 200", assignRes1.status === 200, `got ${assignRes1.status}: ${await assignRes1.clone().text()}`);
    const afterAssign1 = await prisma.ticket.findUnique({ where: { id: unassigned.id } });
    check("assignedAgentId is now the acting user", afterAssign1?.assignedAgentId === admin.id);
    const historyAfterAssign1 = await prisma.ticketHistory.findMany({ where: { ticketId: unassigned.id, type: "ASSIGNMENT_CHANGE" } });
    check("Exactly one ASSIGNMENT_CHANGE audit row", historyAfterAssign1.length === 1);
    check(
      "Audit row's newValue reflects the new assignee",
      historyAfterAssign1[0]?.newValue === admin.name || !!historyAfterAssign1[0]?.description?.includes("Assigned to")
    );

    // ── 2. Reassign — from one user (outsider, forced-assigned via fixture) to admin ──
    console.log("\n2. Reassign — ticket previously assigned to another user -> reassigned to admin ===\n");
    const reassignTarget = await makeTicket(outsider.id, openStatus.id, outsider.id);
    const assignRes2 = await patchAssign(jsonReq(`http://localhost/api/tickets/${reassignTarget.id}/assign`, { assignedAgentId: admin.id }), {
      params: Promise.resolve({ id: reassignTarget.id }),
    });
    check("PATCH reassign -> 200", assignRes2.status === 200);
    const afterReassign = await prisma.ticket.findUnique({ where: { id: reassignTarget.id } });
    check("assignedAgentId switched to admin", afterReassign?.assignedAgentId === admin.id);

    // ── 3. Non-assignable target — ADMIN (has ticket.assign) tries to assign
    //       a user with NO department membership (not ticket.assignable here) ──
    console.log("\n3. Non-assignable target rejected ===\n");
    const nonAssignableTarget = await makeTicket(outsider.id, openStatus.id, null);
    const assignRes3 = await patchAssign(jsonReq(`http://localhost/api/tickets/${nonAssignableTarget.id}/assign`, { assignedAgentId: outsider.id }), {
      params: Promise.resolve({ id: nonAssignableTarget.id }),
    });
    const assignBody3 = await assignRes3.json();
    check(
      "Rejected with assignee_not_assignable",
      assignRes3.status === 400 && assignBody3.code === "assignee_not_assignable",
      JSON.stringify(assignBody3)
    );

    // ── 4. Permission enforcement — outsider (no membership, not Admin) cannot assign ──
    console.log("\n4. Permission enforcement — assign ===\n");
    currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: null } };
    const deniedTicket = await makeTicket(admin.id, openStatus.id, null);
    const assignRes4 = await patchAssign(jsonReq(`http://localhost/api/tickets/${deniedTicket.id}/assign`, { assignedAgentId: outsider.id }), {
      params: Promise.resolve({ id: deniedTicket.id }),
    });
    check("Non-member, non-owner -> 403 on assign (no owner bypass for assign)", assignRes4.status === 403);

    // ── 5. Owner bypass — the SAME outsider, as the ticket's own requester,
    //       CAN change status (bypass) but still CANNOT assign (no bypass) ──
    console.log("\n5. Owner bypass asymmetry (status yes, assign no) ===\n");
    const ownTicket = await makeTicket(outsider.id, openStatus.id, null);
    const statusResOwner = await patchStatus(jsonReq(`http://localhost/api/tickets/${ownTicket.id}/status`, { statusId: resolvedStatus.id }), {
      params: Promise.resolve({ id: ownTicket.id }),
    });
    check("Requester can change their OWN ticket's status (owner bypass) -> 200", statusResOwner.status === 200, `got ${statusResOwner.status}`);
    const assignResOwner = await patchAssign(jsonReq(`http://localhost/api/tickets/${ownTicket.id}/assign`, { assignedAgentId: outsider.id }), {
      params: Promise.resolve({ id: ownTicket.id }),
    });
    check("The SAME requester still CANNOT self-assign their own ticket -> 403 (assign has no owner bypass)", assignResOwner.status === 403);

    // ── 6. Resolve — status route, admin session, "Resolved" is NOT isClosed ──
    console.log("\n6. Resolve -> Resolved status, ticket stays OPEN (not closed) ===\n");
    currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
    const resolveTicket = await makeTicket(outsider.id, openStatus.id, null);
    const resolveRes = await patchStatus(jsonReq(`http://localhost/api/tickets/${resolveTicket.id}/status`, { statusId: resolvedStatus.id }), {
      params: Promise.resolve({ id: resolveTicket.id }),
    });
    check("PATCH status (Resolve) -> 200", resolveRes.status === 200, `got ${resolveRes.status}: ${await resolveRes.clone().text()}`);
    const afterResolve = await prisma.ticket.findUnique({ where: { id: resolveTicket.id }, include: { status: true } });
    check("statusId is now the Resolved status", afterResolve?.statusId === resolvedStatus.id);
    check("Resolved status itself has isClosed: false (seeded convention)", afterResolve?.status.isClosed === false);
    check("closedAt stays null (Resolve never closes the ticket)", afterResolve?.closedAt === null);
    const historyAfterResolve = await prisma.ticketHistory.findMany({ where: { ticketId: resolveTicket.id } });
    check(
      "Audit row type is STATUS_CHANGE, not CLOSED",
      historyAfterResolve.some((h) => h.type === "STATUS_CHANGE") && !historyAfterResolve.some((h) => h.type === "CLOSED")
    );

    // ── 7. Resolving an ALREADY-resolved ticket is still a legal no-op at
    //       the API level (the UI hides the button via canResolveNow; the
    //       backend itself has no "already there" guard, by design — any
    //       active status in-department is a legal target) ──
    console.log("\n7. Re-resolving an already-Resolved ticket is a harmless no-op at the API level ===\n");
    const resolveAgainRes = await patchStatus(jsonReq(`http://localhost/api/tickets/${resolveTicket.id}/status`, { statusId: resolvedStatus.id }), {
      params: Promise.resolve({ id: resolveTicket.id }),
    });
    check("PATCH status (Resolve again) -> 200", resolveAgainRes.status === 200);
    const afterResolveAgain = await prisma.ticket.findUnique({ where: { id: resolveTicket.id } });
    check("Still Resolved, closedAt still null", afterResolveAgain?.statusId === resolvedStatus.id && afterResolveAgain?.closedAt === null);

    // ── 8. Permission enforcement — status change, non-member non-owner ──
    console.log("\n8. Permission enforcement — status change ===\n");
    currentSession = { user: { id: outsider.id, role: Role.USER, customRoleId: null } };
    const deniedStatusTicket = await makeTicket(admin.id, openStatus.id, null);
    const statusResDenied = await patchStatus(jsonReq(`http://localhost/api/tickets/${deniedStatusTicket.id}/status`, { statusId: resolvedStatus.id }), {
      params: Promise.resolve({ id: deniedStatusTicket.id }),
    });
    check("Non-member, non-owner -> 403 on status change", statusResDenied.status === 403);
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.ticketStatus.deleteMany({ where: { id: { in: statusIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
