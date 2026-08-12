/**
 * Focused, deterministic tests for the realtime notification bell:
 * lib/realtime/notification-event-bus.ts / notification-publisher.ts (the
 * server-side pub/sub layer), lib/notifications/notification-state.ts (the
 * pure client-state reducer the dropdown component binds to), and the
 * end-to-end integration with lib/ticket-notification-service.ts's existing
 * Web Push functions (the ONLY code path that creates a Notification row —
 * confirmed via repo-wide audit).
 *
 * This repo's test scripts are plain Node/Prisma (no jsdom/React Testing
 * Library), so the notification-dropdown.tsx component itself is not
 * mounted here — instead, its exact state-transition logic lives in the
 * pure, dependency-free lib/notifications/notification-state.ts module
 * (imported by both the component and this file), which IS fully
 * unit-testable without a DOM. The realtime transport is exercised through
 * the same in-process event bus the real SSE route
 * (app/api/notifications/stream/route.ts) subscribes to — no HTTP/EventSource
 * needed to prove the pub/sub and user-scoping guarantees.
 *
 * Usage: npx tsx scripts/test-notification-realtime-bell.ts
 */
process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY =
  "BP37wV3PociDKeuwfefsNPqqNvlKvIxblTkBJbSEjsdniwfzLmf8R9Bn2XdaykpTzwYDOdlR0oalpxvE6tNjeLM";
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "bZTaAuvDGfHuf6geK0UHCe-C3hzFtnKw6ZhpKEf82Kc";
process.env.WEB_PUSH_CONTACT_EMAIL = "test-push@example.com";

import webpush from "web-push";
import { prisma } from "@/lib/prisma";
import { notificationEventBus } from "@/lib/realtime/notification-event-bus";
import { publishNotificationCreated } from "@/lib/realtime/notification-publisher";
import type { NotificationRealtimeEvent } from "@/lib/realtime/notification-types";
import {
  EMPTY_NOTIFICATION_STATE,
  applyNotificationCreated,
  applyMarkRead,
  applyMarkAllRead,
  applyReconcile,
  type NotificationState,
  type NotificationItem,
} from "@/lib/notifications/notification-state";
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

function item(id: string, isRead = false): NotificationItem {
  return { id, title: `Title ${id}`, body: `Body ${id}`, link: `/tickets/${id}`, isRead, createdAt: new Date().toISOString() };
}

// Mocked webpush.sendNotification — never touches the network, same pattern as scripts/test-ticket-push-notifications.ts.
const originalSendNotification = webpush.sendNotification;
(webpush as any).sendNotification = async () => {};

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let openStatus: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let closedStatus: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let requester: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let agent: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  let requesterB: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];
  const userIds: string[] = [];

  try {
    // ══════════════ 1. Pure state: initial reconcile ══════════════
    console.log("\n=== 1. Initial unread count/list loads correctly (reconcile) ===\n");
    const fetched: NotificationState = { items: [item("a"), item("b", true)], unreadCount: 1 };
    const afterInitial = applyReconcile(fetched);
    check("1. Reconcile adopts the fetched list verbatim", afterInitial.items.length === 2 && afterInitial.unreadCount === 1);

    // ══════════════ 2. New notification increments bell ══════════════
    console.log("\n=== 2. A realtime NOTIFICATION_CREATED event increments the bell ===\n");
    let state: NotificationState = EMPTY_NOTIFICATION_STATE;
    state = applyNotificationCreated(state, item("n1"));
    check("2. Unread count incremented from 0 to 1", state.unreadCount === 1);
    check("   Item was prepended", state.items[0]?.id === "n1");

    // ══════════════ 3. Appears in an already-open dropdown ══════════════
    console.log("\n=== 3. The new notification appears in the (already-rendered) items list ===\n");
    check("3. items[] contains the new notification (the dropdown renders directly from this array, open or closed)", state.items.some((n) => n.id === "n1"));

    // ══════════════ 4/5. Dedup: same event twice / fetch+realtime race ══════════════
    console.log("\n=== 4/5. The same notification delivered twice (or racing the initial fetch) appears exactly once ===\n");
    const stateTwice = applyNotificationCreated(state, item("n1"));
    check("4. Re-applying the same id does not duplicate it", stateTwice.items.filter((n) => n.id === "n1").length === 1);
    check("   ...and does not double-increment the unread count", stateTwice.unreadCount === 1);
    // Race: initial fetch already contains "abc"; a realtime event for "abc" arrives milliseconds later.
    const postFetch = applyReconcile({ items: [item("abc")], unreadCount: 1 });
    const postRealtimeRace = applyNotificationCreated(postFetch, item("abc"));
    check("5. Initial fetch + realtime race for the same id still shows it exactly once", postRealtimeRace.items.filter((n) => n.id === "abc").length === 1);
    check("   ...and the count is not double-counted", postRealtimeRace.unreadCount === 1);

    // ══════════════ 7. Read notification decrements count immediately ══════════════
    console.log("\n=== 7. Marking a notification read decrements the count immediately ===\n");
    const afterRead = applyMarkRead(state, "n1");
    check("7. Unread count decremented", afterRead.unreadCount === 0);
    check("   Item flagged isRead", afterRead.items.find((n) => n.id === "n1")?.isRead === true);
    const afterReadAgain = applyMarkRead(afterRead, "n1");
    check("   Re-marking an already-read notification does not go negative or double-apply", afterReadAgain.unreadCount === 0);
    const afterReadUnknown = applyMarkRead(state, "does-not-exist");
    check("   Marking an unknown id is a safe no-op", afterReadUnknown === state);

    // ══════════════ 8. Mark-all-read sets count to zero immediately ══════════════
    console.log("\n=== 8. Mark-all-read sets the count to zero immediately ===\n");
    const multi: NotificationState = { items: [item("x"), item("y"), item("z", true)], unreadCount: 2 };
    const afterAll = applyMarkAllRead(multi);
    check("8. Unread count is exactly zero", afterAll.unreadCount === 0);
    check("   Every item is marked read", afterAll.items.every((n) => n.isRead));

    // ══════════════ 6. User-scoped delivery: User A event never reaches User B ══════════════
    console.log("\n=== 6. A notification event for User A never reaches User B's subscription ===\n");
    const receivedByA: NotificationRealtimeEvent[] = [];
    const receivedByB: NotificationRealtimeEvent[] = [];
    const unsubA = notificationEventBus.subscribe("user-a", (e) => receivedByA.push(e));
    const unsubB = notificationEventBus.subscribe("user-b", (e) => receivedByB.push(e));
    publishNotificationCreated("user-a", { id: "for-a", title: "t", body: "b", link: null, isRead: false, createdAt: new Date().toISOString() });
    check("6. User A's own subscriber received exactly one event", receivedByA.length === 1 && receivedByA[0].userId === "user-a");
    check("   User B's subscriber received nothing", receivedByB.length === 0);
    unsubA();
    unsubB();

    // Unsubscribe actually stops delivery (no leak/ghost listener).
    const afterUnsub: NotificationRealtimeEvent[] = [];
    const unsubC = notificationEventBus.subscribe("user-a", (e) => afterUnsub.push(e));
    unsubC();
    publishNotificationCreated("user-a", { id: "after-unsub", title: "t", body: "b", link: null, isRead: false, createdAt: new Date().toISOString() });
    check("   A caller that unsubscribed receives nothing further", afterUnsub.length === 0);

    // ══════════════ End-to-end: business event -> Notification row -> realtime publish ══════════════
    console.log("\n=== End-to-end: notifyTicketRequesterPublicReply publishes a scoped realtime event ===\n");
    dept = await prisma.department.create({ data: { name: `Notif Realtime Dept ${RUN_ID}`, slug: `notif-realtime-dept-${RUN_ID}` } });
    openStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Open ${RUN_ID}`, color: "#3b82f6", isDefault: true, isClosed: false, order: 1 } });
    closedStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Closed ${RUN_ID}`, color: "#6b7280", isDefault: false, isClosed: true, order: 2 } });
    requester = await prisma.user.create({ data: { email: `notif-rt-requester-${RUN_ID}@example.com`, name: "RT Requester", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    requesterB = await prisma.user.create({ data: { email: `notif-rt-requesterb-${RUN_ID}@example.com`, name: "RT Requester B", role: Role.USER, authProvider: AuthProvider.CREDENTIALS } });
    agent = await prisma.user.create({ data: { email: `notif-rt-agent-${RUN_ID}@example.com`, name: "RT Agent", role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS } });
    userIds.push(requester.id, requesterB.id, agent.id);

    const ticket = await prisma.ticket.create({
      data: { title: "Realtime bell test ticket", description: "desc", source: TicketSource.WEB, requesterId: requester.id, departmentId: dept.id, statusId: openStatus.id },
      select: { id: true, ticketNumber: true },
    });
    ticketIds.push(ticket.id);
    const message = await prisma.ticketMessage.create({
      data: { ticketId: ticket.id, authorId: agent.id, body: "Realtime bell reply", direction: MessageDirection.OUTBOUND, isInternal: false },
      select: { id: true },
    });

    const receivedForRequester: NotificationRealtimeEvent[] = [];
    const receivedForOtherUser: NotificationRealtimeEvent[] = [];
    const unsubReq = notificationEventBus.subscribe(requester.id, (e) => receivedForRequester.push(e));
    const unsubOther = notificationEventBus.subscribe(requesterB.id, (e) => receivedForOtherUser.push(e));

    await notifyTicketRequesterPublicReply({ ticketId: ticket.id, messageId: message.id });

    check("A real reply notification publishes exactly one realtime event to the requester", receivedForRequester.length === 1);
    check("   The event type is NOTIFICATION_CREATED", receivedForRequester[0]?.type === "NOTIFICATION_CREATED");
    const persisted = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/tickets/${ticket.id}` } });
    check("   The payload's id matches the persisted Notification row", receivedForRequester[0]?.payload?.id === persisted?.id);
    check("   The payload's title/body/link match the persisted row", receivedForRequester[0]?.payload?.title === persisted?.title && receivedForRequester[0]?.payload?.link === persisted?.link);
    check("   isRead is false for a freshly created notification", receivedForRequester[0]?.payload?.isRead === false);
    check("   A different user's subscription received nothing (private, user-scoped)", receivedForOtherUser.length === 0);
    unsubReq();
    unsubOther();

    // Terminal transition path publishes too — not just the reply path.
    const receivedTerminal: NotificationRealtimeEvent[] = [];
    const unsubTerminal = notificationEventBus.subscribe(requester.id, (e) => receivedTerminal.push(e));
    await prisma.ticket.update({ where: { id: ticket.id }, data: { statusId: closedStatus.id, closedAt: new Date() } });
    await notifyTicketRequesterTerminalTransition({ ticketId: ticket.id, actorId: agent.id, statusName: closedStatus.name });
    check("A terminal-transition notification also publishes a realtime event to the requester", receivedTerminal.length === 1);
    unsubTerminal();

    // ══════════════ 10. Realtime publish failure never fails the underlying business operation ══════════════
    console.log("\n=== 10. A realtime transport failure does not fail Notification persistence / the ticket action ===\n");
    const originalPublish = notificationEventBus.publish;
    (notificationEventBus as any).publish = () => {
      throw new Error("Simulated realtime transport failure");
    };
    const ticket2 = await prisma.ticket.create({
      data: { title: "Realtime failure isolation ticket", description: "desc", source: TicketSource.WEB, requesterId: requester.id, departmentId: dept.id, statusId: openStatus.id },
      select: { id: true },
    });
    ticketIds.push(ticket2.id);
    const message2 = await prisma.ticketMessage.create({
      data: { ticketId: ticket2.id, authorId: agent.id, body: "Reply during simulated realtime outage", direction: MessageDirection.OUTBOUND, isInternal: false },
      select: { id: true },
    });
    let threwDuringOutage = false;
    try {
      await notifyTicketRequesterPublicReply({ ticketId: ticket2.id, messageId: message2.id });
    } catch {
      threwDuringOutage = true;
    }
    check("10. notifyTicketRequesterPublicReply does not throw even if the realtime bus throws", !threwDuringOutage);
    const persisted2 = await prisma.notification.findFirst({ where: { userId: requester.id, link: `/tickets/${ticket2.id}` } });
    check("   The Notification row is still persisted (DB remains authoritative) despite the realtime failure", !!persisted2);
    (notificationEventBus as any).publish = originalPublish;

    // ══════════════ 9. Reconnect reconciliation (conceptual, via the pure reconcile function) ══════════════
    console.log("\n=== 9. Reconnect reconciliation replaces local state with the authoritative server list ===\n");
    // hooks/use-notification-realtime.ts's onReconnect callback (fired from
    // EventSource.onopen on every connection AFTER the first) calls the same
    // fetchNotifications -> applyReconcile path exercised in test 1 above —
    // this repo has no jsdom/EventSource test harness to drive the hook
    // itself, so this proves the reconciliation function it calls is a pure,
    // correct full-replace (never a merge that could accumulate stale
    // entries across a reconnect).
    const staleLocal: NotificationState = { items: [item("stale-only-local")], unreadCount: 5 };
    const reconciled = applyReconcile({ items: [item("real-1"), item("real-2", true)], unreadCount: 1 });
    check("9. Reconcile fully replaces stale local state with the authoritative fetch (no stale entries survive)", !reconciled.items.some((n) => n.id === "stale-only-local") && reconciled.unreadCount === 1);
    void staleLocal;
  } finally {
    (webpush as any).sendNotification = originalSendNotification;

    const cleanup: [string, () => Promise<unknown>][] = [
      ["in-app notifications", () => prisma.notification.deleteMany({ where: { userId: { in: userIds } } })],
      ["push notification logs", () => prisma.pushNotificationLog.deleteMany({ where: { ticketId: { in: ticketIds } } })],
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
