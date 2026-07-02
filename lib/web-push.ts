import "server-only";
import webpush from "web-push";
import { prisma } from "@/lib/prisma";

if (
  process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY &&
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY &&
  process.env.WEB_PUSH_CONTACT_EMAIL
) {
  webpush.setVapidDetails(
    `mailto:${process.env.WEB_PUSH_CONTACT_EMAIL}`,
    process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY,
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY
  );
}

export interface PushPayload {
  title: string;
  body: string;
  link?: string;
}

export async function sendPushNotificationsToUser(
  userId: string,
  payload: PushPayload
): Promise<void> {
  if (
    !process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY ||
    !process.env.WEB_PUSH_VAPID_PRIVATE_KEY
  ) {
    return;
  }

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });

  if (subscriptions.length === 0) return;

  const data = JSON.stringify(payload);

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          data
        );
      } catch (err: any) {
        // Remove stale subscriptions (expired or unsubscribed)
        if (err.statusCode === 410 || err.statusCode === 404) {
          await prisma.pushSubscription.deleteMany({
            where: { endpoint: sub.endpoint },
          });
        }
      }
    })
  );
}
