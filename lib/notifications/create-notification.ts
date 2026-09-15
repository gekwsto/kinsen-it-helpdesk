import { prisma } from "@/lib/prisma";
import { publishNotificationCreated } from "@/lib/realtime/notification-publisher";
import { sendPushNotificationsToUser } from "@/lib/web-push";

/**
 * Generic in-app + web-push notification creator — the same two-step
 * "Notification row, then realtime publish, then Web Push" sequence
 * lib/ticket-notification-service.ts's deliverRequesterPush already
 * establishes for ticket reply/terminal pushes, pulled out here so a
 * non-ticket feature (Note @mentions, first user) doesn't have to either
 * reach into that ticket-specific file or reimplement the sequence. Reuses
 * the exact same Notification model, the same publishNotificationCreated
 * realtime event, and the same sendPushNotificationsToUser delivery —
 * never a parallel notification mechanism.
 *
 * Deliberately simpler than deliverRequesterPush: no EmailNotificationLog/
 * PushNotificationLog idempotency ledger, because callers here are expected
 * to have already ensured they're only calling this once per real event
 * (see lib/services/mention-service.ts's own dedup — one call per uniquely
 * mentioned user, never per token occurrence). A push failure is caught and
 * logged, never thrown — the caller's own write (e.g. the Note) has already
 * committed by the time this runs and must never appear to have failed
 * because a push provider hiccuped.
 */
export async function createInAppNotification(params: {
  userId: string;
  title: string;
  body: string;
  link?: string | null;
}): Promise<void> {
  let created: { id: string; title: string; body: string; link: string | null; isRead: boolean; createdAt: Date };
  try {
    created = await prisma.notification.create({
      data: { userId: params.userId, title: params.title, body: params.body, link: params.link ?? null },
    });
  } catch (err) {
    console.error("[notification] Failed to create in-app notification:", err);
    return;
  }

  try {
    publishNotificationCreated(params.userId, {
      id: created.id,
      title: created.title,
      body: created.body,
      link: created.link,
      isRead: created.isRead,
      createdAt: created.createdAt.toISOString(),
    });
  } catch (err) {
    // Never lets a realtime-publish hiccup look like the notification
    // itself failed — the row above is already committed.
    console.error("[notification] Failed to publish realtime notification event:", err);
  }

  try {
    await sendPushNotificationsToUser(params.userId, {
      title: params.title,
      body: params.body,
      link: params.link ?? undefined,
    });
  } catch (err) {
    console.error("[notification] Failed to send web push:", err);
  }
}
