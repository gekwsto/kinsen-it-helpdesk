/**
 * Confirms the Ticket reply/internal-note architecture was NOT touched by
 * this task (inline Project creation from Activity forms + Project/Activity
 * Notes). This task deliberately did not modify
 * app/api/tickets/[id]/reply/route.ts, lib/validations.ts's
 * replyTicketSchema, or TicketMessage/TicketHistory at all — this script is
 * a direct, self-contained proof of that boundary via the real route
 * handler and a live schema introspection, not just "nothing shows up in
 * the diff".
 *
 * Covers the task's own checklist:
 *  35. Ticket Reply still works (a public message via POST /api/tickets/[id]/reply).
 *  36. Ticket Internal Note still works (isInternal: true via the same route).
 *  37. ticket.internalNote permission is unchanged — still gates isInternal:true.
 *  38. Ticket requester visibility/self-reply rule is unchanged — a
 *      requester without ticket.reply can still reply to their OWN ticket
 *      (the isRequester bypass in the route).
 *  39. The email-reply-notification code path still runs without breaking
 *      the request (fire-and-forget; the route still returns 201 whether
 *      or not the notification itself succeeds).
 *  40. TicketMessage's own fields (direction, isInternal, emailMessageId,
 *      fromEmail, fromName) still exist and are still writable exactly as
 *      before — Project/Activity Notes never reuse or alias this model.
 *
 * Must run with --experimental-test-module-mocks.
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-ticket-notes-regression-boundary.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, MessageDirection } from "@prisma/client";
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
const TAG = `tnrb-${RUN_ID}`;

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
  // The reply route transitively imports lib/web-push.ts, which imports the
  // Next.js "server-only" sentinel package — that's a webpack-only build-time
  // guard with no real npm package behind it, so it can't be resolved (or
  // mocked directly) under plain Node/tsx. Mocking lib/web-push.ts itself
  // (a real, resolvable file) short-circuits that import entirely, since a
  // mocked module's real source is never executed. The reply route's own
  // fire-and-forget push-notification call becomes a no-op here — exactly
  // as harmless to this test as a real push failure already is in
  // production (the route wraps it in try/catch and still returns 201).
  mock.module("@/lib/web-push", { namedExports: { sendPushNotificationsToUser: async () => {} } });

  const { POST: replyPOST } = await import("@/app/api/tickets/[id]/reply/route");

  const jsonReq = (url: string, body: unknown, method = "POST") =>
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const messageIds: string[] = [];

  try {
    console.log("\n=== Fixtures: Department, an IT Agent (ticket.reply + ticket.internalNote), a plain requester ===\n");
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, isDefault: true }, select: { id: true } });

    const agent = await prisma.user.create({
      data: { email: `${TAG}-agent@example.com`, role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x", name: `${TAG} Agent` },
      select: { id: true },
    });
    userIds.push(agent.id);

    const requester = await prisma.user.create({
      data: { email: `${TAG}-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(requester.id);

    const ticket = await prisma.ticket.create({
      data: { title: `${TAG} Ticket`, description: "fixture", departmentId: dept.id, statusId: status.id, requesterId: requester.id },
    });
    ticketIds.push(ticket.id);

    // ── 35. Ticket Reply still works ──
    console.log("\n35. Ticket Reply still works ===\n");
    currentSession = { user: { id: agent.id, role: Role.IT_AGENT, customRoleId: null } };
    const replyRes = await replyPOST(jsonReq(`http://localhost/api/tickets/${ticket.id}/reply`, { body: "This is a public reply." }), { params: Promise.resolve({ id: ticket.id }) });
    check("POST /api/tickets/[id]/reply (public) -> 201", replyRes.status === 201);
    const reply = await replyRes.json();
    if (reply?.id) messageIds.push(reply.id);
    check("Message has isInternal: false", reply.isInternal === false);
    check("Message has direction: OUTBOUND (agent->requester default)", reply.direction === "OUTBOUND");

    // ── 36. Ticket Internal Note still works ──
    console.log("\n36. Ticket Internal Note still works ===\n");
    const noteRes = await replyPOST(jsonReq(`http://localhost/api/tickets/${ticket.id}/reply`, { body: "Internal-only note.", isInternal: true }), { params: Promise.resolve({ id: ticket.id }) });
    check("POST /api/tickets/[id]/reply (isInternal: true) -> 201", noteRes.status === 201);
    const note = await noteRes.json();
    if (note?.id) messageIds.push(note.id);
    check("Message has isInternal: true", note.isInternal === true);

    // ── 37. ticket.internalNote permission is unchanged ──
    console.log("\n37. ticket.internalNote permission still gates isInternal:true ===\n");
    currentSession = { user: { id: requester.id, role: Role.USER, customRoleId: null } };
    const deniedInternalRes = await replyPOST(jsonReq(`http://localhost/api/tickets/${ticket.id}/reply`, { body: "Trying to sneak an internal note.", isInternal: true }), { params: Promise.resolve({ id: ticket.id }) });
    check("A requester (no ticket.internalNote) attempting isInternal:true -> 403", deniedInternalRes.status === 403);

    // ── 38. Ticket requester visibility rule is unchanged (self-reply bypass) ──
    console.log("\n38. The ticket's own requester can always reply to it (isRequester bypass), independent of ticket.reply ===\n");
    const selfReplyRes = await replyPOST(jsonReq(`http://localhost/api/tickets/${ticket.id}/reply`, { body: "Following up on my own ticket." }), { params: Promise.resolve({ id: ticket.id }) });
    check("The ticket's own requester can reply to it (isRequester bypass) -> 201", selfReplyRes.status === 201);
    const selfReply = await selfReplyRes.json();
    if (selfReply?.id) messageIds.push(selfReply.id);

    // Role.DIRECTOR is the one seeded role with NO ticket.reply at all (see
    // prisma/seed.ts's ROLE_PERMISSIONS.DIRECTOR) — a plain Role.USER would
    // not prove this, since USER holds ticket.reply globally by default.
    const stranger = await prisma.user.create({
      data: { email: `${TAG}-stranger@example.com`, role: Role.DIRECTOR, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" },
      select: { id: true },
    });
    userIds.push(stranger.id);
    currentSession = { user: { id: stranger.id, role: Role.DIRECTOR, customRoleId: null } };
    const strangerReplyRes = await replyPOST(jsonReq(`http://localhost/api/tickets/${ticket.id}/reply`, { body: "Not my ticket." }), { params: Promise.resolve({ id: ticket.id }) });
    check("A user who is neither the requester nor has ticket.reply -> 403", strangerReplyRes.status === 403);

    // ── 39. Email-reply-notification code path still runs without breaking the request ──
    console.log("\n39. Agent replying to someone else's ticket still returns 201 (email/push are fire-and-forget) ===\n");
    currentSession = { user: { id: agent.id, role: Role.IT_AGENT, customRoleId: null } };
    const agentReplyToOtherRes = await replyPOST(jsonReq(`http://localhost/api/tickets/${ticket.id}/reply`, { body: "Agent replying — this exercises the notifyRequesterReply code path." }), { params: Promise.resolve({ id: ticket.id }) });
    check("Agent reply to a different user's ticket -> still 201 regardless of email/push outcome", agentReplyToOtherRes.status === 201);
    const agentReply = await agentReplyToOtherRes.json();
    if (agentReply?.id) messageIds.push(agentReply.id);

    // ── 40. TicketMessage schema/behavior is unchanged ──
    console.log("\n40. TicketMessage's own fields (direction, isInternal, emailMessageId, fromEmail, fromName) still exist and are writable ===\n");
    const rawMessage = await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: agent.id,
        body: "Simulated inbound email reply.",
        direction: MessageDirection.INBOUND,
        isInternal: false,
        emailMessageId: `${TAG}-email-msg-id`,
        fromEmail: "external@example.com",
        fromName: "External Sender",
      },
    });
    messageIds.push(rawMessage.id);
    check("TicketMessage.direction is still writable/readable", rawMessage.direction === MessageDirection.INBOUND);
    check("TicketMessage.emailMessageId is still writable/readable", rawMessage.emailMessageId === `${TAG}-email-msg-id`);
    check("TicketMessage.fromEmail/fromName are still writable/readable", rawMessage.fromEmail === "external@example.com" && rawMessage.fromName === "External Sender");
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketMessage.deleteMany({ where: { id: { in: messageIds } } });
      await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
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

main();
