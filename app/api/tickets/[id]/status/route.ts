import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canActOnEntity, validateTicketConfigOwnership } from "@/lib/services/department-scope-service";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import { changeStatusSchema } from "@/lib/validations";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { notifyRequesterClosed, notifyTicketRequesterTerminalTransition } from "@/lib/ticket-notification-service";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Users can close/cancel their own tickets; those with department-scoped
    // ticket.changeStatus can change any ticket in their department.
    const canChange = await canActOnEntity(
      session.user.id,
      session.user.role,
      ticket.departmentId,
      "ticket.changeStatus",
      ticket.requesterId === session.user.id
    );

    if (!canChange) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { statusId, cancelReasonId } = changeStatusSchema.parse(body);

    // A submitted statusId must belong to THIS ticket's own department —
    // never silently accepted from a different one (see
    // validateTicketConfigOwnership's own doc comment for the full
    // rationale/incident this guards against). Legacy (departmentId: null)
    // tickets fall back to the same default legacy department used
    // elsewhere for this exact case.
    const effectiveTicketDepartmentId = ticket.departmentId ?? (await getDefaultLegacyDepartmentId());
    if (!effectiveTicketDepartmentId) {
      return NextResponse.json({ error: "This ticket has no department to validate the status against.", code: "invalid_department_scope" }, { status: 400 });
    }
    const ownership = await validateTicketConfigOwnership(effectiveTicketDepartmentId, { statusId });
    if (!ownership.ok) {
      return NextResponse.json({ error: ownership.message, code: `${ownership.field}_department_mismatch` }, { status: 400 });
    }

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

    // Only a REAL open->closed transition, never merely "the new status
    // happens to be closed" — that distinction matters for a closed->closed
    // change (e.g. "Closed" -> "Resolved-Closed", both isClosed: true),
    // which must NOT re-send this email. Deferred via after(); the DB write
    // above has already committed, so this can never fail or roll back the
    // status change itself, and notifyRequesterClosed's own eventKey
    // (scoped to this transition's persisted closedAt) is the actual
    // duplicate-send guard even under a concurrent/retried request.
    if (oldStatus && !oldStatus.isClosed && newStatus?.isClosed) {
      after(() =>
        notifyRequesterClosed({
          ticketId: id,
          statusName: newStatus.name,
          closingMessage: updated.cancelReason?.name,
        })
      );
      // Web Push — independent side effect, own eventKey/idempotency (see
      // notifyTicketRequesterTerminalTransition), skips the actor if they
      // closed their own ticket.
      after(() =>
        notifyTicketRequesterTerminalTransition({
          ticketId: id,
          actorId: session.user.id,
          statusName: newStatus.name,
        })
      );
    }

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
