import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { assignTicketSchema } from "@/lib/validations";
import { publishTicketEvent } from "@/lib/realtime/publisher";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const canAssign = await hasPermission(session.user.role, "ticket.assign", session.user.customRoleId);
    if (!canAssign) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const body = await req.json();
    const { assignedAgentId } = assignTicketSchema.parse(body);

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [oldAgent, newAgent] = await Promise.all([
      ticket.assignedAgentId
        ? prisma.user.findUnique({ where: { id: ticket.assignedAgentId } })
        : null,
      assignedAgentId
        ? prisma.user.findUnique({ where: { id: assignedAgentId } })
        : null,
    ]);

    const updated = await prisma.ticket.update({
      where: { id: id },
      data: { assignedAgentId },
      include: {
        assignedAgent: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    await prisma.ticketHistory.create({
      data: {
        ticketId: id,
        changedById: session.user.id,
        type: "ASSIGNMENT_CHANGE",
        oldValue: oldAgent?.name ?? "Unassigned",
        newValue: newAgent?.name ?? "Unassigned",
        description: assignedAgentId
          ? `Assigned to ${newAgent?.name ?? assignedAgentId}`
          : "Unassigned",
      },
    });

    publishTicketEvent("TICKET_ASSIGNEE_CHANGED", id, session.user.id, {
      assignedAgent: updated.assignedAgent,
    });

    return NextResponse.json(updated);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
