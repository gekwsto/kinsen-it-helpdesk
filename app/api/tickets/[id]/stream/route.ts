import { NextRequest } from "next/server";
import { requireAuth, canViewAllTickets, hasPermission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ticketEventBus } from "@/lib/realtime/event-bus";
import type { TicketRealtimeEvent } from "@/lib/realtime/types";

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

      // Heartbeat every 20 s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        if (isClosed) {
          clearInterval(heartbeat);
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
