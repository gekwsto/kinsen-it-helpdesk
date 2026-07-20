import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { assignTicketSchema } from "@/lib/validations";
import { publishTicketEvent } from "@/lib/realtime/publisher";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canAssign = await canActOnEntity(
      session.user.id,
      session.user.role,
      ticket.departmentId,
      "ticket.assign"
    );
    if (!canAssign) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const { assignedAgentId } = assignTicketSchema.parse(body);

    if (assignedAgentId) {
      const assignable = await userHasAssignablePermissionForEntity(assignedAgentId, "ticket", ticket.departmentId);
      if (!assignable) {
        return NextResponse.json(
          { error: "This user cannot be assigned to tickets in this department.", code: "assignee_not_assignable" },
          { status: 400 }
        );
      }
    }

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
