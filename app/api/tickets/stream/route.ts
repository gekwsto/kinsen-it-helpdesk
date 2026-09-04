import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { ticketListChangeHub } from "@/lib/realtime/ticket-list-change-hub";
import { isAbsoluteSessionExpired } from "@/lib/session-expiry";

export const dynamic = "force-dynamic";

/**
 * List-level SSE stream — distinct from the per-ticket
 * app/api/tickets/[id]/stream/route.ts. Any authenticated user may open
 * this: the only thing it ever sends is a generic "TICKETS_CHANGED" pulse
 * with NO ticket data whatsoever (no id, no title, no department, nothing)
 * — the realtime transport is deliberately not an authorization boundary
 * (see lib/realtime/ticket-list-invalidation.ts). The client's only correct
 * reaction is to re-run its OWN already-authorized server-side ticket
 * query (router.refresh() on a Server Component ticket-list page — see
 * hooks/use-ticket-list-realtime.ts) — that query is what actually decides,
 * per-viewer, what changed and whether it's visible to them.
 *
 * Backed by ticketListChangeHub, which is itself backed by PostgreSQL
 * LISTEN/NOTIFY (not the in-process-only event buses the per-ticket/
 * notification streams use) — this is what makes this specific stream
 * correct across multiple Node processes/containers.
 *
 * Mirrors app/api/notifications/stream/route.ts's shape exactly (heartbeat,
 * absolute session-expiry enforcement, abort cleanup).
 */
export async function GET(req: NextRequest) {
  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

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

      send({ type: "CONNECTED", createdAt: new Date().toISOString() });

      const unsubscribe = ticketListChangeHub.subscribe(() => {
        send({ type: "TICKETS_CHANGED", createdAt: new Date().toISOString() });
      });

      const heartbeat = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeat);
          return;
        }
        if (isAbsoluteSessionExpired(expiresAt)) {
          send({ type: "SESSION_EXPIRED", createdAt: new Date().toISOString() });
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
