import "server-only";
import webpush from "web-push";
import { prisma } from "@/lib/prisma";

// Computed once at module load — never re-read per call, and never logs the
// actual key/email values (only whether each is present), so this can be
// safely printed without leaking secrets.
const VAPID_CONFIGURED = !!(
  process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY &&
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY &&
  process.env.WEB_PUSH_CONTACT_EMAIL
);

if (VAPID_CONFIGURED) {
  webpush.setVapidDetails(
    `mailto:${process.env.WEB_PUSH_CONTACT_EMAIL}`,
    process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY!,
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY!
  );
} else {
  // A clear, one-time, secret-free diagnostic — Web Push silently no-ops on
  // every call below when this fires (never breaks a ticket action), but an
  // administrator/developer should still be able to tell it's disabled and
  // why, without any log ever containing a key/email value.
  console.warn(
    "[web-push] VAPID configuration is incomplete — Web Push is disabled. " +
      "Set NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_CONTACT_EMAIL to enable it. " +
      `(present: publicKey=${!!process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY}, privateKey=${!!process.env.WEB_PUSH_VAPID_PRIVATE_KEY}, contactEmail=${!!process.env.WEB_PUSH_CONTACT_EMAIL})`
  );
}

/** Whether Web Push is currently configured (all 3 VAPID env vars present) — never exposes the values themselves. Safe to surface in diagnostics/admin UI. */
export function isWebPushConfigured(): boolean {
  return VAPID_CONFIGURED;
}

export interface PushPayload {
  title: string;
  body: string;
  link?: string;
}

/**
 * Outcome summary for a fan-out send — lets a caller (e.g.
 * lib/ticket-notification-service.ts's push idempotency log) distinguish
 * "nothing to deliver to" (subscriptionCount 0 — no PushSubscription rows,
 * or VAPID not configured) from "attempted but every subscription failed"
 * (subscriptionCount > 0, sentCount 0) from a genuine partial/full success.
 * Purely additive to the previous void-returning signature — every existing
 * `await sendPushNotificationsToUser(...)` call site that ignores the
 * return value keeps working unchanged.
 */
export interface PushSendResult {
  subscriptionCount: number;
  sentCount: number;
  failedCount: number;
}

const NO_SUBSCRIPTIONS: PushSendResult = { subscriptionCount: 0, sentCount: 0, failedCount: 0 };

export async function sendPushNotificationsToUser(
  userId: string,
  payload: PushPayload
): Promise<PushSendResult> {
  if (!VAPID_CONFIGURED) {
    return NO_SUBSCRIPTIONS;
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });

  if (subscriptions.length === 0) return NO_SUBSCRIPTIONS;

  const data = JSON.stringify(payload);

  // Every subscription is handled independently — one dead/erroring
  // subscription (stale or otherwise) must never prevent another
  // subscription belonging to the SAME user from receiving the push, and a
  // delivery failure here must never throw out to the caller (a ticket
  // action's own success is never allowed to depend on push delivery).
  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          data
        );
        return true;
      } catch (err: any) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          // Remove stale subscriptions (expired or unsubscribed) — deleted
          // by endpoint (globally unique), never touching any OTHER
          // subscription for this or any other user.
          await prisma.pushSubscription.deleteMany({
            where: { endpoint: sub.endpoint },
          });
        } else {
          // Never log the endpoint/auth/p256dh values themselves (subscription
          // secrets) or anything VAPID-related — only the HTTP status/message
          // needed to diagnose a delivery problem.
          console.error("[web-push] Delivery failed", {
            statusCode: err?.statusCode ?? null,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return false;
      }
    })
  );

  const sentCount = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  return {
    subscriptionCount: subscriptions.length,
    sentCount,
    failedCount: subscriptions.length - sentCount,
  };
}
