import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { notificationEventBus } from "@/lib/realtime/notification-event-bus";
import type { NotificationRealtimeEvent } from "@/lib/realtime/notification-types";
import { isAbsoluteSessionExpired } from "@/lib/session-expiry";

export const dynamic = "force-dynamic";

/**
 * Per-user SSE stream for the notification bell — mirrors
 * app/api/tickets/[id]/stream/route.ts's shape exactly (heartbeat, absolute
 * session-expiry enforcement, abort cleanup), scoped to a single topic: the
 * CALLER'S OWN userId, taken only from the authenticated session — never
 * from a query param or request body. This is what makes the channel
 * inherently user-scoped: there is no way for a client to subscribe to
 * anyone else's notifications, because the topic key is never
 * client-supplied.
 */
export async function GET(req: NextRequest) {
  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.user.id;
  const expiresAt = session.user.absoluteSessionExpiresAt;
  const encoder = new TextEncoder();
  let isClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        if (isClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          isClosed = true;
        }
      };

      send({ type: "CONNECTED", userId, payload: null, createdAt: new Date().toISOString() });

      const unsubscribe = notificationEventBus.subscribe(userId, (event: NotificationRealtimeEvent) => {
        send(event);
      });

      const heartbeat = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeat);
          return;
        }
        if (isAbsoluteSessionExpired(expiresAt)) {
          send({ type: "SESSION_EXPIRED", userId, payload: null, createdAt: new Date().toISOString() });
          isClosed = true;
          unsubscribe();
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {}
          return;
        }
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          isClosed = true;
          clearInterval(heartbeat);
        }
      }, 20_000);

      req.signal.addEventListener("abort", () => {
        isClosed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
