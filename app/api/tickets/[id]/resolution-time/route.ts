import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canViewTicket, hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { updateResolutionTimeSchema } from "@/lib/validations";
import { setTicketResolutionTimeInTransaction } from "@/lib/services/ticket-resolution-time-service";
import { publishTicketEvent } from "@/lib/realtime/publisher";

/**
 * Standalone add / edit / clear of a ticket's manual Resolution Time — any
 * status, including resolved and closed tickets. Requires the dedicated
 * department-scoped ticket.resolutionTime.edit permission (global grant OR
 * a grant in THIS ticket's own department). Never touches status, closedAt
 * or SLA data. (Submitting a duration while resolving goes through
 * PATCH /api/tickets/[id]/status instead, gated by ticket.changeStatus.)
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [canView, canEdit] = await Promise.all([
      canViewTicket(session.user.id, session.user.role, ticket),
      hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, ticket.departmentId, "ticket.resolutionTime.edit"),
    ]);
    if (!canView || !canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { resolutionTimeMinutes } = updateResolutionTimeSchema.parse(await req.json());

    const change = await prisma.$transaction((tx) =>
      setTicketResolutionTimeInTransaction(tx, { ticketId: id, actorId: session.user.id, minutes: resolutionTimeMinutes })
    );

    if (change.changed) {
      publishTicketEvent("TICKET_RESOLUTION_TIME_CHANGED", id, session.user.id, { resolutionTimeMinutes: change.current });
    }
    return NextResponse.json({ resolutionTimeMinutes: change.current, changed: change.changed });
  } catch (error: any) {
    if (error?.message === "Unauthorized" || error?.name === "SessionExpiredError") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error?.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
