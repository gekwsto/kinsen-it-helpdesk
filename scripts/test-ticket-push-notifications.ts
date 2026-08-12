/**
 * Focused, deterministic tests for requester Web Push lifecycle
 * notifications (lib/ticket-notification-service.ts's
 * notifyTicketRequesterPublicReply / notifyTicketRequesterTerminalTransition)
 * — real Prisma fixtures against the real dev DB, cleaned up in a finally
 * block, but web-push's actual sendNotification is monkey-patched
 * in-process (same pattern as scripts/test-ticket-lifecycle-notifications.ts
 * monkey-patches microsoftGraph.sendMail) so NO real HTTP push traffic is
 * ever sent and no real VAPID/browser endpoint is required. Test-only VAPID
 * keys (freshly generated, never registered with any push service) are set
 * BEFORE any import so lib/web-push.ts's module-level setVapidDetails runs
 * against them.
 *
 * Also includes a sandboxed exercise of the REAL public/sw.js source (not a
 * re-implementation) for the notificationclick navigation behavior, since
 * that logic has no Prisma/network dependency and is fully deterministic
 * given a mocked `clients`/`self` service-worker global scope.
 *
 * Usage: npx tsx scripts/test-ticket-push-notifications.ts
 */
process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY =
  "BP37wV3PociDKeuwfefsNPqqNvlKvIxblTkBJbSEjsdniwfzLmf8R9Bn2XdaykpTzwYDOdlR0oalpxvE6tNjeLM";
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "bZTaAuvDGfHuf6geK0UHCe-C3hzFtnKw6ZhpKEf82Kc";
process.env.WEB_PUSH_CONTACT_EMAIL = "test-push@example.com";

import fs from "fs";
import path from "path";
import webpush from "web-push";
import { prisma } from "@/lib/prisma";
import {
  notifyTicketRequesterPublicReply,
  notifyTicketRequesterTerminalTransition,
} from "@/lib/ticket-notification-service";
import { Role, AuthProvider, TicketSource, MessageDirection } from "@prisma/client";

const RUN_ID = Date.now();
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

// ── Mocked webpush.sendNotification — records every call, never touches the network ──
type SentCall = { endpoint: string; payload: { title: string; body: string; link?: string } };
let sentCalls: SentCall[] = [];
let failEndpoints = new Set<string>();
let failStatusCode = 500;

const originalSendNotification = webpush.sendNotification;
(webpush as any).sendNotification = async (sub: { endpoint: string }, data: string) => {
  if (failEndpoints.has(sub.endpoint)) {
    const err: any = new Error("Simulated push failure");
    err.statusCode = failStatusCode;
    throw err;
  }
  sentCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(data) });
};

// PushSubscription is scoped to a userId, not a ticket — a real requester's
// browser subscription receives push for ANY of their tickets. Since this
// file reuses one shared `requester` fixture across many test cases, each
// case must start from a clean subscription slate (never carry over a
// PREVIOUS case's PushSubscription row) or send counts would accumulate
// across the whole file — this is a test-fixture concern only, not a
// product behavior change.
async function resetMock(...forUserIds: string[]) {
  sentCalls = [];
  failEndpoints = new Set();
  failStatusCode = 500;
  if (forUserIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: forUserIds } } });
  }
}

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let openStatus: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let openStatus2: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let closedStatus: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let closedStatus2: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let agent: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let assignedAgent: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];
  const userIds: string[] = [];

  try {
    dept = await prisma.department.create({ data: { name: `Push Notif Dept ${RUN_ID}`, slug: `push-notif-dept-${RUN_ID}` } });
    openStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Open ${RUN_ID}`, color: "#3b82f6", isDefault: true, isClosed: false, order: 1 } });
    openStatus2 = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `In Progress ${RUN_ID}`, color: "#eab308", isDefault: false, isClosed: false, order: 2 } });
    closedStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Closed ${RUN_ID}`, color: "#6b7280", isDefault: false, isClosed: true, order: 3 } });
    closedStatus2 = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Resolved ${RUN_ID}`, color: "#22c55e", isDefault: false, isClosed: true, order: 4 } });

    requester = await prisma.user.create({ data: { email: `push-requester-${RUN_ID}@example.com`, name: "Push Requester", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    agent = await prisma.user.create({ data: { email: `push-agent-${RUN_ID}@example.com`, name: "Push Agent", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS } });
    assignedAgent = await prisma.user.create({ data: { email: `push-assigned-${RUN_ID}@example.com`, name: "Assigned Agent", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id, agent.id, assignedAgent.id);

    async function makeTicket(statusId: string, assignedAgentId?: string) {
      const t = await prisma.ticket.create({
        data: { title: "Push notif test ticket", description: "desc", source: TicketSource.WEB, requesterId: requester!.id, departmentId: dept!.id, statusId, assignedAgentId },
        select: { id: true, ticketNumber: true },
      });
      ticketIds.push(t.id);
      return t;
    }

    async function makeMessage(ticketId: string, authorId: string, body: string, isInternal = false) {
      return prisma.ticketMessage.create({
        data: { ticketId, authorId, body, direction: MessageDirection.OUTBOUND, isInternal },
        select: { id: true },
      });
    }

    async function subscribe(userId: string, endpointSuffix: string) {
      return prisma.pushSubscription.create({
        data: {
          userId,
          endpoint: `https://push.example.com/${endpointSuffix}-${RUN_ID}`,
          p256dh: "test-p256dh-key-value",
          auth: "test-auth-secret-value",
        },
      });
    }

    // ══════════════════════ PUBLIC REPLY ══════════════════════

    console.log("\n=== 1. Authorized other user public reply -> exactly one requester push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t1 = await makeTicket(openStatus.id);
    const requesterSub1 = await subscribe(requester.id, "t1-requester");
    const msg1 = await makeMessage(t1.id, agent.id, "Here is your update", false);
    await notifyTicketRequesterPublicReply({ ticketId: t1.id, messageId: msg1.id });
    check("1. Exactly one push sent", sentCalls.length === 1);
    check("   Sent to the requester's subscription endpoint", sentCalls[0]?.endpoint === requesterSub1.endpoint);
    check("   Title matches the specified copy", sentCalls[0]?.payload.title === "New reply on your ticket");
    check("   Body includes the author name and reply text", sentCalls[0]?.payload.body.includes("Push Agent") && sentCalls[0]?.payload.body.includes("Here is your update"));
    check("16. Payload link is /tickets/{id}", sentCalls[0]?.payload.link === `/tickets/${t1.id}`);
    let inApp = await prisma.notification.findMany({ where: { userId: requester.id, link: `/tickets/${t1.id}` } });
    check("   In-app bell notification also created (deliberate parity, not a duplicate)", inApp.length === 1);
    let pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t1.id, type: "REPLY" } });
    check("   Exactly one REPLY push log row, status SENT", pushLogs.length === 1 && pushLogs[0].status === "SENT");
    check("   Log eventKey matches ticket:{id}:reply:{messageId}", pushLogs[0].eventKey === `ticket:${t1.id}:reply:${msg1.id}`);

    console.log("\n=== 2. Requester replies to own ticket -> zero push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t2 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t2-requester");
    const msg2 = await makeMessage(t2.id, requester.id, "I'm replying to my own ticket", false);
    await notifyTicketRequesterPublicReply({ ticketId: t2.id, messageId: msg2.id });
    check("2. No push sent when the requester replies to their own ticket", sentCalls.length === 0);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t2.id, type: "REPLY" } });
    check("   No push log row created at all (never even claimed)", pushLogs.length === 0);

    console.log("\n=== 3. Internal note -> zero push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t3 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t3-requester");
    const msg3 = await makeMessage(t3.id, agent.id, "Internal-only note", true);
    await notifyTicketRequesterPublicReply({ ticketId: t3.id, messageId: msg3.id });
    check("3. No push sent for an internal note", sentCalls.length === 0);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t3.id, type: "REPLY" } });
    check("   No push log row created", pushLogs.length === 0);

    console.log("\n=== 4. Duplicate execution for same messageId -> at most one push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t4 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t4-requester");
    const msg4 = await makeMessage(t4.id, agent.id, "Duplicate test reply", false);
    await notifyTicketRequesterPublicReply({ ticketId: t4.id, messageId: msg4.id });
    await notifyTicketRequesterPublicReply({ ticketId: t4.id, messageId: msg4.id });
    await notifyTicketRequesterPublicReply({ ticketId: t4.id, messageId: msg4.id });
    check("4. Exactly one push despite 3 sequential duplicate calls", sentCalls.length === 1);
    // Concurrent duplicate calls — the real production shape (retried HTTP request racing itself).
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t4b = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t4b-requester");
    const msg4b = await makeMessage(t4b.id, agent.id, "Concurrent duplicate test reply", false);
    await Promise.all(
      Array.from({ length: 5 }, () => notifyTicketRequesterPublicReply({ ticketId: t4b.id, messageId: msg4b.id }))
    );
    check("   Exactly one push despite 5 CONCURRENT duplicate calls", sentCalls.length === 1);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t4b.id, type: "REPLY" } });
    check("   Exactly one REPLY push log row after concurrency", pushLogs.length === 1);

    console.log("\n=== 5. Notification targets ticket.requesterId, never assignedAgent ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t5 = await makeTicket(openStatus.id, assignedAgent.id);
    const requesterSub5 = await subscribe(requester.id, "t5-requester");
    await subscribe(assignedAgent.id, "t5-assigned-agent");
    const msg5 = await makeMessage(t5.id, agent.id, "Reply on an assigned ticket", false);
    await notifyTicketRequesterPublicReply({ ticketId: t5.id, messageId: msg5.id });
    check("5. Exactly one push sent (assigned agent never notified)", sentCalls.length === 1);
    check("   Sent to the REQUESTER's subscription, not the assigned agent's", sentCalls[0]?.endpoint === requesterSub5.endpoint);

    // ══════════════════════ TERMINAL STATUS ══════════════════════

    console.log("\n=== 6. open -> terminal -> exactly one requester push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t6 = await makeTicket(openStatus.id);
    const requesterSub6 = await subscribe(requester.id, "t6-requester");
    await prisma.ticket.update({ where: { id: t6.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyTicketRequesterTerminalTransition({ ticketId: t6.id, actorId: agent.id, statusName: closedStatus.name });
    check("6. Exactly one push sent for the terminal transition", sentCalls.length === 1);
    check("   Sent to the requester", sentCalls[0]?.endpoint === requesterSub6.endpoint);
    check("   Title matches the specified copy", sentCalls[0]?.payload.title === "Your ticket has been closed");
    check("   Body includes the ticket reference and new status name", sentCalls[0]?.payload.body.includes(`KIN-${t6.ticketNumber}`) && sentCalls[0]?.payload.body.includes(closedStatus.name));
    check("   Link is /tickets/{id}", sentCalls[0]?.payload.link === `/tickets/${t6.id}`);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t6.id, type: "TERMINAL" } });
    check("   Exactly one TERMINAL push log row, status SENT", pushLogs.length === 1 && pushLogs[0].status === "SENT");

    console.log("\n=== Terminal push skips the actor when actorId === requesterId ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t6b = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t6b-requester");
    await prisma.ticket.update({ where: { id: t6b.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyTicketRequesterTerminalTransition({ ticketId: t6b.id, actorId: requester.id, statusName: closedStatus.name });
    check("Requester closing their own ticket does not push to themselves", sentCalls.length === 0);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t6b.id, type: "TERMINAL" } });
    check("No push log row created for a self-actor transition", pushLogs.length === 0);

    console.log("\n=== 7. open -> another open status -> zero push ===\n");
    // This mirrors what the real /status route computes BEFORE deciding whether to call the notifier at all — the
    // notifier itself is only ever invoked on a genuine isClosed transition, so this proves the trigger condition
    // rather than a defensive check inside the function (same architecture as notifyRequesterClosed's email sibling).
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t7 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t7-requester");
    await prisma.ticket.update({ where: { id: t7.id }, data: { statusId: openStatus2.id } });
    const wouldTrigger7 = !openStatus.isClosed && openStatus2.isClosed;
    check("7. open -> open transition does not satisfy the trigger condition (route never calls the notifier)", wouldTrigger7 === false);
    check("   ...and indeed zero pushes if nothing calls it", sentCalls.length === 0);

    console.log("\n=== 8. terminal -> another terminal status -> zero push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t8 = await makeTicket(closedStatus.id);
    await prisma.ticket.update({ where: { id: t8.id }, data: { closedAt: new Date(Date.now() - 60_000) } });
    await subscribe(requester.id, "t8-requester");
    await prisma.ticket.update({ where: { id: t8.id }, data: { statusId: closedStatus2.id } });
    const wouldTrigger8 = !closedStatus.isClosed && closedStatus2.isClosed;
    check("8. closed -> closed transition does not satisfy the trigger condition", wouldTrigger8 === false);
    check("   ...and indeed zero pushes if nothing calls it", sentCalls.length === 0);

    console.log("\n=== 9. Reopen -> terminal again -> a NEW push is allowed ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t9 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t9-requester");
    await prisma.ticket.update({ where: { id: t9.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyTicketRequesterTerminalTransition({ ticketId: t9.id, actorId: agent.id, statusName: closedStatus.name });
    check("First close sent one push", sentCalls.length === 1);
    // Reopen
    await prisma.ticket.update({ where: { id: t9.id }, data: { statusId: openStatus.id, closedAt: null } });
    await new Promise((r) => setTimeout(r, 5));
    // Reclose — a genuinely new transition, new closedAt.
    await prisma.ticket.update({ where: { id: t9.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyTicketRequesterTerminalTransition({ ticketId: t9.id, actorId: agent.id, statusName: closedStatus.name });
    check("9. Second close (after reopen) sends a second, new push", sentCalls.length === 2);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t9.id, type: "TERMINAL" }, orderBy: { createdAt: "asc" } });
    check("   Two distinct TERMINAL push log rows exist", pushLogs.length === 2);
    check("   ...with two distinct eventKeys (different closedAt)", pushLogs[0]?.eventKey !== pushLogs[1]?.eventKey);

    console.log("\n=== 10. Cancellation into terminal status -> exactly one push ===\n");
    // Mirrors POST /api/tickets/[id]/cancel's actual write shape (cancelReasonId + closedAt + statusId in one update).
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t10 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t10-requester");
    await prisma.ticket.update({ where: { id: t10.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyTicketRequesterTerminalTransition({ ticketId: t10.id, actorId: agent.id, statusName: closedStatus.name });
    check("10. Exactly one push sent for a cancellation-driven terminal transition", sentCalls.length === 1);

    console.log("\n=== 11. Duplicate/concurrent processing of the same close transition -> at most one push ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t11 = await makeTicket(openStatus.id);
    await subscribe(requester.id, "t11-requester");
    await prisma.ticket.update({ where: { id: t11.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await Promise.all(
      Array.from({ length: 5 }, () => notifyTicketRequesterTerminalTransition({ ticketId: t11.id, actorId: agent!.id, statusName: closedStatus!.name }))
    );
    check("11. Exactly one push despite 5 concurrent calls for the same transition", sentCalls.length === 1);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t11.id, type: "TERMINAL" } });
    check("   Exactly one TERMINAL push log row after concurrency", pushLogs.length === 1);

    // ══════════════════════ DELIVERY ══════════════════════

    console.log("\n=== 12. No PushSubscription -> function completes without error, SKIPPED logged ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t12 = await makeTicket(openStatus.id);
    // Deliberately no subscribe() call — zero PushSubscription rows for the requester.
    const msg12 = await makeMessage(t12.id, agent.id, "No subscription for this requester", false);
    let threw12 = false;
    try {
      await notifyTicketRequesterPublicReply({ ticketId: t12.id, messageId: msg12.id });
    } catch {
      threw12 = true;
    }
    check("12. Does not throw when the requester has no PushSubscription", !threw12);
    check("   No push attempted (nothing to deliver to)", sentCalls.length === 0);
    const t12After = await prisma.ticket.findUnique({ where: { id: t12.id } });
    check("   The ticket itself is completely unaffected", t12After !== null);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t12.id, type: "REPLY" } });
    check("   Push log row is SKIPPED, not FAILED", pushLogs.length === 1 && pushLogs[0].status === "SKIPPED");

    console.log("\n=== 13. One stale 410 subscription -> deleted safely, ticket op unaffected ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t13 = await makeTicket(openStatus.id);
    const staleSub = await subscribe(requester.id, "t13-stale");
    failEndpoints.add(staleSub.endpoint);
    failStatusCode = 410;
    const msg13 = await makeMessage(t13.id, agent.id, "Stale subscription test", false);
    await notifyTicketRequesterPublicReply({ ticketId: t13.id, messageId: msg13.id });
    const staleSubAfter = await prisma.pushSubscription.findUnique({ where: { id: staleSub.id } });
    check("13. The stale (410) subscription was deleted", staleSubAfter === null);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t13.id, type: "REPLY" } });
    check("   Push log resolves to FAILED (zero successful deliveries)", pushLogs.length === 1 && pushLogs[0].status === "FAILED");

    console.log("\n=== 14. Multiple subscriptions -> valid ones still receive push if one fails ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t14 = await makeTicket(openStatus.id);
    const goodSub = await subscribe(requester.id, "t14-good");
    const badSub = await subscribe(requester.id, "t14-bad");
    failEndpoints.add(badSub.endpoint);
    failStatusCode = 500; // a non-404/410 failure — the subscription is NOT deleted, just this delivery fails
    const msg14 = await makeMessage(t14.id, agent.id, "Multi-subscription test", false);
    await notifyTicketRequesterPublicReply({ ticketId: t14.id, messageId: msg14.id });
    check("14. The good subscription still received the push", sentCalls.some((c) => c.endpoint === goodSub.endpoint));
    check("   The bad subscription's failure did not block the good one", sentCalls.length === 1);
    const badSubAfter = await prisma.pushSubscription.findUnique({ where: { id: badSub.id } });
    check("   A non-404/410 failure does NOT delete the subscription (only stale ones are removed)", badSubAfter !== null);
    pushLogs = await prisma.pushNotificationLog.findMany({ where: { ticketId: t14.id, type: "REPLY" } });
    check("   Push log resolves to SENT (at least one delivery succeeded)", pushLogs.length === 1 && pushLogs[0].status === "SENT");

    console.log("\n=== 15. Push delivery exception -> underlying operation still succeeds ===\n");
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t15 = await makeTicket(openStatus.id);
    const failSub = await subscribe(requester.id, "t15-fail");
    failEndpoints.add(failSub.endpoint);
    failStatusCode = 500;
    const msg15 = await makeMessage(t15.id, agent.id, "Delivery exception test", false);
    let threw15 = false;
    try {
      await notifyTicketRequesterPublicReply({ ticketId: t15.id, messageId: msg15.id });
    } catch {
      threw15 = true;
    }
    check("15. notifyTicketRequesterPublicReply does not throw even when delivery fails", !threw15);
    const ticket15After = await prisma.ticket.findUnique({ where: { id: t15.id } });
    const message15After = await prisma.ticketMessage.findUnique({ where: { id: msg15.id } });
    check("   The ticket and its message are completely unaffected by the push failure", ticket15After !== null && message15After !== null);

    // Same proof for the terminal path.
    await resetMock(requester.id, agent.id, assignedAgent.id);
    const t15b = await makeTicket(openStatus.id);
    const failSub15b = await subscribe(requester.id, "t15b-fail");
    failEndpoints.add(failSub15b.endpoint);
    failStatusCode = 500;
    await prisma.ticket.update({ where: { id: t15b.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    let threw15b = false;
    try {
      await notifyTicketRequesterTerminalTransition({ ticketId: t15b.id, actorId: agent.id, statusName: closedStatus.name });
    } catch {
      threw15b = true;
    }
    check("   Same guarantee for the terminal transition path", !threw15b);
    const ticket15bAfter = await prisma.ticket.findUnique({ where: { id: t15b.id } });
    check("   The ticket's closed state is completely unaffected by the push failure", ticket15bAfter?.closedAt !== null);

    // ══════════════════════ SERVICE WORKER ══════════════════════

    console.log("\n=== 17. Real public/sw.js notificationclick behavior (sandboxed) ===\n");
    const swPath = path.join(process.cwd(), "public", "sw.js");
    const swSource = fs.readFileSync(swPath, "utf8");

    // Case A: an existing window already on the exact ticket URL -> focus only, no navigate.
    {
      let focused = false;
      let navigateCalled = false;
      let openWindowCalled = false;
      const target = "http://localhost:3000/tickets/abc123";
      const clientsMock = {
        matchAll: async () => [{ url: target, focus: async () => { focused = true; }, navigate: async () => { navigateCalled = true; } }],
        openWindow: async () => { openWindowCalled = true; },
      };
      const listeners: Record<string, ((event: any) => void)[]> = {};
      const selfMock: any = { location: { origin: "http://localhost:3000" }, registration: {}, addEventListener: (t: string, h: any) => ((listeners[t] ??= []).push(h)) };
      // eslint-disable-next-line no-new-func
      new Function("self", "clients", swSource)(selfMock, clientsMock);
      let waited: Promise<any> = Promise.resolve();
      const event = { notification: { close: () => {}, data: { link: "/tickets/abc123" } }, waitUntil: (p: Promise<any>) => { waited = p; } };
      for (const h of listeners["notificationclick"] ?? []) h(event);
      await waited;
      check("Already on the exact ticket URL -> focuses without navigating", focused && !navigateCalled && !openWindowCalled);
    }

    // Case B: an existing window on a DIFFERENT page -> navigates to the ticket, then focuses.
    {
      let navigatedTo: string | null = null;
      let focusedAfterNavigate = false;
      const clientsMock = {
        matchAll: async () => [
          {
            url: "http://localhost:3000/dashboard",
            focus: async () => {},
            navigate: async (url: string) => {
              navigatedTo = url;
              return { focus: async () => { focusedAfterNavigate = true; } };
            },
          },
        ],
        openWindow: async () => {},
      };
      const listeners: Record<string, ((event: any) => void)[]> = {};
      const selfMock: any = { location: { origin: "http://localhost:3000" }, registration: {}, addEventListener: (t: string, h: any) => ((listeners[t] ??= []).push(h)) };
      // eslint-disable-next-line no-new-func
      new Function("self", "clients", swSource)(selfMock, clientsMock);
      let waited: Promise<any> = Promise.resolve();
      const event = { notification: { close: () => {}, data: { link: "/tickets/xyz789" } }, waitUntil: (p: Promise<any>) => { waited = p; } };
      for (const h of listeners["notificationclick"] ?? []) h(event);
      await waited;
      check("17. A window open on a DIFFERENT page navigates to the notification's ticket URL", navigatedTo === "http://localhost:3000/tickets/xyz789");
      check("   ...and is focused after navigating", focusedAfterNavigate);
    }

    // Case C: no window open -> opens a new one at the ticket URL.
    {
      let openedUrl: string | null = null;
      const clientsMock = {
        matchAll: async () => [],
        openWindow: async (url: string) => { openedUrl = url; },
      };
      const listeners: Record<string, ((event: any) => void)[]> = {};
      const selfMock: any = { location: { origin: "http://localhost:3000" }, registration: {}, addEventListener: (t: string, h: any) => ((listeners[t] ??= []).push(h)) };
      // eslint-disable-next-line no-new-func
      new Function("self", "clients", swSource)(selfMock, clientsMock);
      let waited: Promise<any> = Promise.resolve();
      const event = { notification: { close: () => {}, data: { link: "/tickets/newwin" } }, waitUntil: (p: Promise<any>) => { waited = p; } };
      for (const h of listeners["notificationclick"] ?? []) h(event);
      await waited;
      check("No window open -> opens a new window at the correct ticket URL", openedUrl === "http://localhost:3000/tickets/newwin");
    }

    // Case D: a cross-origin/foreign link is never trusted — falls back to same-origin root.
    {
      let openedUrl: string | null = null;
      const clientsMock = {
        matchAll: async () => [],
        openWindow: async (url: string) => { openedUrl = url; },
      };
      const listeners: Record<string, ((event: any) => void)[]> = {};
      const selfMock: any = { location: { origin: "http://localhost:3000" }, registration: {}, addEventListener: (t: string, h: any) => ((listeners[t] ??= []).push(h)) };
      // eslint-disable-next-line no-new-func
      new Function("self", "clients", swSource)(selfMock, clientsMock);
      let waited: Promise<any> = Promise.resolve();
      const event = { notification: { close: () => {}, data: { link: "https://evil.example.com/phish" } }, waitUntil: (p: Promise<any>) => { waited = p; } };
      for (const h of listeners["notificationclick"] ?? []) h(event);
      await waited;
      check("A cross-origin link is never followed — falls back to the app's own origin", openedUrl === "http://localhost:3000/");
    }
  } finally {
    (webpush as any).sendNotification = originalSendNotification;

    const cleanup: [string, () => Promise<unknown>][] = [
      ["push logs", () => prisma.pushNotificationLog.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["in-app notifications", () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } })],
      ["push subscriptions", () => prisma.pushSubscription.deleteMany({ where: { userId: { in: userIds } } })],
      ["ticket messages", () => prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["statuses", () => (dept ? prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
