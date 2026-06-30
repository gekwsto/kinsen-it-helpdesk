import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { changeStatusSchema } from "@/lib/validations";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { notifyRequesterClosed } from "@/lib/ticket-notification-service";
import { recalculateFromTicket } from "@/lib/projects/progress-rollup";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Users can close/cancel their own tickets; those with ticket.changeStatus can change any
    const hasChangeStatus = await hasPermission(session.user.role, "ticket.changeStatus", session.user.customRoleId);
    const canChange = hasChangeStatus || ticket.requesterId === session.user.id;

    if (!canChange) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { statusId, cancelReasonId } = changeStatusSchema.parse(body);

    const [oldStatus, newStatus] = await Promise.all([
      prisma.ticketStatus.findUnique({ where: { id: ticket.statusId } }),
      prisma.ticketStatus.findUnique({ where: { id: statusId } }),
    ]);

    const updated = await prisma.ticket.update({
      where: { id: id },
      data: {
        statusId,
        cancelReasonId: cancelReasonId ?? null,
        closedAt: newStatus?.isClosed ? new Date() : null,
      },
      include: {
        status: true,
        cancelReason: true,
      },
    });

    await prisma.ticketHistory.create({
      data: {
        ticketId: id,
        changedById: session.user.id,
        type: newStatus?.isClosed ? "CLOSED" : "STATUS_CHANGE",
        oldValue: oldStatus?.name,
        newValue: newStatus?.name,
        description: `Status changed from "${oldStatus?.name}" to "${newStatus?.name}"`,
      },
    });

    publishTicketEvent("TICKET_STATUS_CHANGED", id, session.user.id, {
      status: updated.status,
      closedAt: updated.closedAt?.toISOString() ?? null,
    });

    // Fire-and-forget closed notification to requester
    if (newStatus?.isClosed) {
      notifyRequesterClosed({
        ticketId: id,
        statusName: newStatus.name,
        closingMessage: updated.cancelReason?.name,
      }).catch((err) => {
        console.error("[notification] Failed to send closed notification:", err);
      });
    }

    recalculateFromTicket(id).catch((err) => {
      console.error("[progress-rollup] status change recalculation failed:", err);
    });

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
