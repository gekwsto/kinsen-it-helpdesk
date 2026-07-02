import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdmin, canManageTickets, canViewAllTickets, hasPermission } from "@/lib/permissions";
import { updateTicketSchema } from "@/lib/validations";
import { Role } from "@prisma/client";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { recalculateFromTicket, recalculateProjectRollup } from "@/lib/projects/progress-rollup";
import path from "path";
import fs from "fs/promises";

const TICKET_INCLUDE = {
  requester: { select: { id: true, name: true, email: true, image: true } },
  assignedAgent: { select: { id: true, name: true, email: true, image: true } },
  status: true,
  priority: true,
  category: true,
  department: { select: { id: true, name: true } },
  cancelReason: true,
  messages: {
    orderBy: { createdAt: "asc" as const },
    include: {
      author: { select: { id: true, name: true, email: true, image: true, role: true } },
      attachments: true,
    },
  },
  attachments: {
    orderBy: { createdAt: "asc" as const },
    include: {
      uploadedBy: { select: { id: true, name: true } },
    },
  },
  history: {
    orderBy: { createdAt: "desc" as const },
    include: {
      changedBy: { select: { id: true, name: true, image: true } },
    },
  },
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: TICKET_INCLUDE,
    });

    if (!ticket) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const canView =
      canViewAllTickets(session.user.role) ||
      ticket.requesterId === session.user.id;

    if (!canView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Filter internal notes for users without the internalNote permission
    const canSeeInternal = await hasPermission(session.user.role, "ticket.internalNote", session.user.customRoleId);
    if (!canSeeInternal) {
      ticket.messages = ticket.messages.filter((m) => !m.isInternal) as any;
    }

    return NextResponse.json(ticket);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canManage = await hasPermission(session.user.role, "ticket.changeStatus", session.user.customRoleId);
    const canEdit = canManage || ticket.requesterId === session.user.id;

    if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const data = updateTicketSchema.parse(body);

    // Only administrators can change a ticket's project or activity link
    const projectChanging = data.projectId !== undefined && data.projectId !== ticket.projectId;
    const activityChanging = data.activityId !== undefined && data.activityId !== ticket.activityId;
    if ((projectChanging || activityChanging) && session.user.role !== Role.ADMIN) {
      return NextResponse.json(
        { error: "Only administrators can link tickets to projects or activities" },
        { status: 403 }
      );
    }

    const oldProjectId = ticket.projectId;
    const oldActivityId = ticket.activityId;

    // Track changes for history
    const historyEntries: Array<{
      type: string;
      oldValue?: string;
      newValue?: string;
      description: string;
    }> = [];

    if (data.statusId && data.statusId !== ticket.statusId) {
      const [oldStatus, newStatus] = await Promise.all([
        prisma.ticketStatus.findUnique({ where: { id: ticket.statusId } }),
        prisma.ticketStatus.findUnique({ where: { id: data.statusId } }),
      ]);
      historyEntries.push({
        type: newStatus?.isClosed ? "CLOSED" : "STATUS_CHANGE",
        oldValue: oldStatus?.name,
        newValue: newStatus?.name,
        description: `Status changed from "${oldStatus?.name}" to "${newStatus?.name}"`,
      });
    }

    if (data.priorityId !== undefined && data.priorityId !== ticket.priorityId) {
      const [oldP, newP] = await Promise.all([
        ticket.priorityId ? prisma.ticketPriority.findUnique({ where: { id: ticket.priorityId } }) : null,
        data.priorityId ? prisma.ticketPriority.findUnique({ where: { id: data.priorityId } }) : null,
      ]);
      historyEntries.push({
        type: "PRIORITY_CHANGE",
        oldValue: oldP?.name,
        newValue: newP?.name,
        description: `Priority changed from "${oldP?.name ?? "None"}" to "${newP?.name ?? "None"}"`,
      });
    }

    if (data.assignedAgentId !== undefined && data.assignedAgentId !== ticket.assignedAgentId) {
      const [oldAgent, newAgent] = await Promise.all([
        ticket.assignedAgentId ? prisma.user.findUnique({ where: { id: ticket.assignedAgentId } }) : null,
        data.assignedAgentId ? prisma.user.findUnique({ where: { id: data.assignedAgentId } }) : null,
      ]);
      historyEntries.push({
        type: "ASSIGNMENT_CHANGE",
        oldValue: oldAgent?.name ?? undefined,
        newValue: newAgent?.name ?? undefined,
        description: `Assigned to ${newAgent?.name ?? "Unassigned"}`,
      });
    }

    const updatedTicket = await prisma.ticket.update({
      where: { id: id },
      data: {
        ...data,
        closedAt:
          data.statusId
            ? await prisma.ticketStatus
                .findUnique({ where: { id: data.statusId } })
                .then((s) => (s?.isClosed ? new Date() : undefined))
            : undefined,
      },
      include: TICKET_INCLUDE,
    });

    // Record history
    if (historyEntries.length > 0) {
      await prisma.ticketHistory.createMany({
        data: historyEntries.map((e) => ({
          ticketId: id,
          changedById: session.user.id,
          type: e.type as any,
          oldValue: e.oldValue,
          newValue: e.newValue,
          description: e.description,
        })),
      });
    }

    // Publish granular real-time events for each changed field
    if (data.priorityId !== undefined && data.priorityId !== ticket.priorityId) {
      publishTicketEvent("TICKET_PRIORITY_CHANGED", id, session.user.id, {
        priority: updatedTicket.priority,
      });
    }
    if (data.statusId && data.statusId !== ticket.statusId) {
      publishTicketEvent("TICKET_STATUS_CHANGED", id, session.user.id, {
        status: updatedTicket.status,
        closedAt: updatedTicket.closedAt?.toISOString() ?? null,
      });
    }
    if (data.assignedAgentId !== undefined && data.assignedAgentId !== ticket.assignedAgentId) {
      publishTicketEvent("TICKET_ASSIGNEE_CHANGED", id, session.user.id, {
        assignedAgent: updatedTicket.assignedAgent,
      });
    }

    // Recalculate progress rollup when project/activity assignment changes
    const projectChanged = data.projectId !== undefined && data.projectId !== oldProjectId;
    const activityChanged = data.activityId !== undefined && data.activityId !== oldActivityId;

    if (projectChanged || activityChanged) {
      // Recalculate old project (ticket is now unlinked from it)
      if (oldProjectId) {
        recalculateProjectRollup(oldProjectId).catch((err) => {
          console.error("[progress-rollup] old project recalculation failed:", err);
        });
      }
      // Recalculate for new assignment
      recalculateFromTicket(id).catch((err) => {
        console.error("[progress-rollup] new assignment recalculation failed:", err);
      });
    }

    return NextResponse.json(updatedTicket);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAdmin();

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: { id: true, ticketNumber: true },
    });

    if (!ticket) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Remove physical attachment files stored under UPLOAD_DIR/{ticketId}/
    const uploadDir = process.env.UPLOAD_DIR || "./public/uploads";
    const ticketDir = path.join(uploadDir, id);
    try {
      await fs.rm(ticketDir, { recursive: true, force: true });
    } catch {
      // Directory may not exist — safe to ignore
    }

    // Cascade in schema: TicketMessage, TicketAttachment, TicketHistory all have onDelete: Cascade
    await prisma.ticket.delete({ where: { id } });

    console.log(`[ticket-delete] #${ticket.ticketNumber} (${id}) deleted by ${session.user.email}`);

    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
