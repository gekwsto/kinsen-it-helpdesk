import { NextRequest } from "next/server";
import { requireAuth, canViewAllTickets, hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ticketEventBus } from "@/lib/realtime/event-bus";
import type { TicketRealtimeEvent } from "@/lib/realtime/types";
import { isAbsoluteSessionExpired } from "@/lib/session-expiry";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let session: Awaited<ReturnType<typeof requireAuth>>;
  try {
    session = await requireAuth();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const ticket = await prisma.ticket.findUnique({
    where: { id },
    select: { id: true, requesterId: true },
  });

  if (!ticket) return new Response("Not found", { status: 404 });

  const canView =
    canViewAllTickets(session.user.role) ||
    ticket.requesterId === session.user.id;

  if (!canView) return new Response("Forbidden", { status: 403 });

  const canSeeInternal = await hasPermission(session.user.role, "ticket.internalNote", session.user.customRoleId);
  // Captured once at connection-open — never re-read from a fresh session
  // lookup later, so a long-lived stream can never have its own enforcement
  // window silently extended by anything happening elsewhere.
  const expiresAt = session.user.absoluteSessionExpiresAt;
  const encoder = new TextEncoder();
  let isClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        if (isClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          isClosed = true;
        }
      };

      // Confirm connection
      send({
        type: "CONNECTED",
        ticketId: id,
        createdAt: new Date().toISOString(),
        actorId: session.user.id,
        payload: null,
      });

      const unsubscribe = ticketEventBus.subscribe(
        id,
        (event: TicketRealtimeEvent) => {
          // Guard internal notes for regular users
          if (
            event.type === "TICKET_INTERNAL_NOTE_CREATED" &&
            !canSeeInternal
          ) {
            return;
          }
          send(event);
        }
      );

      // Heartbeat every 20 s to keep connection alive through proxies — also
      // the only enforcement point for the absolute 8h session boundary on
      // THIS connection: an SSE stream is long-lived and, unlike a normal
      // request, only ever authenticates once (at connection-open, above)
      // — without an active check here, a connection opened at, say, 07:00
      // would keep silently delivering ticket events straight through the
      // 8h mark with no further authorization check at all. `expiresAt` is
      // captured once, from the connection-open session, and never
      // re-read/extended — closing here never depends on whether the
      // client has independently noticed and signed out yet.
      const heartbeat = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeat);
          return;
        }
        if (isAbsoluteSessionExpired(expiresAt)) {
          send({ type: "SESSION_EXPIRED", ticketId: id, createdAt: new Date().toISOString(), actorId: session.user.id, payload: null });
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
