import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, isAdmin } from "@/lib/permissions";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import { z } from "zod";

const cancelSchema = z.object({
  cancelReasonId: z.string().min(1),
  note: z.string().max(1000).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: { status: true },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const actorIsAdmin = isAdmin(session.user.role);
    const actorIsRequester = ticket.requesterId === session.user.id;

    if (!actorIsAdmin && !actorIsRequester) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (ticket.cancelReasonId !== null) {
      return NextResponse.json({ error: "Ticket is already cancelled" }, { status: 409 });
    }

    if (ticket.status.isClosed) {
      return NextResponse.json({ error: "Ticket is already closed" }, { status: 409 });
    }

    const body = await req.json();
    const data = cancelSchema.parse(body);

    // Only active cancel reasons are valid
    const cancelReason = await prisma.ticketCancelReason.findFirst({
      where: { id: data.cancelReasonId, isActive: true },
    });
    if (!cancelReason) {
      return NextResponse.json({ error: "Cancel reason not found or inactive" }, { status: 422 });
    }

    // Find a closed status to move the ticket into, if one exists — scoped
    // to the ticket's own department (every status is department-owned now,
    // so an unscoped lookup could pick another department's "Closed" status
    // entirely). Legacy tickets with no department fall back to the same
    // default legacy department used elsewhere for this exact case.
    const statusDepartmentId = ticket.departmentId ?? (await getDefaultLegacyDepartmentId());
    const closedStatus = statusDepartmentId
      ? await prisma.ticketStatus.findFirst({
          where: { departmentId: statusDepartmentId, isClosed: true, isActive: true },
          orderBy: { order: "asc" },
        })
      : null;

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.ticket.update({
        where: { id },
        data: {
          cancelReasonId: data.cancelReasonId,
          closedAt: new Date(),
          ...(closedStatus ? { statusId: closedStatus.id } : {}),
        },
        include: { status: true },
      });

      const actor = actorIsAdmin ? "admin" : "requester";
      const noteText = data.note?.trim() ? ` — ${data.note.trim()}` : "";

      await tx.ticketHistory.create({
        data: {
          ticketId: id,
          changedById: session.user.id,
          type: "CANCEL_REASON_SET",
          newValue: cancelReason.name,
          description: `Cancelled by ${actor}: ${cancelReason.name}${noteText}`,
        },
      });

      // Admin notes become internal messages; requester notes stay in history only
      if (actorIsAdmin && data.note?.trim()) {
        await tx.ticketMessage.create({
          data: {
            ticketId: id,
            authorId: session.user.id,
            body: `**Cancellation note:** ${cancelReason.name}\n\n${data.note.trim()}`,
            direction: "INTERNAL_NOTE",
            isInternal: true,
          },
        });
      }

      return updated;
    });

    publishTicketEvent("TICKET_STATUS_CHANGED", id, session.user.id, {
      status: result.status,
      closedAt: result.closedAt?.toISOString() ?? null,
    });

    return NextResponse.json({
      status: result.status,
      cancelReasonId: result.cancelReasonId,
      closedAt: result.closedAt?.toISOString() ?? null,
    });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
