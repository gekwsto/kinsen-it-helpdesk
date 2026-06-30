import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { canViewAllTickets } from "@/lib/permissions";

export async function GET() {
  try {
    const session = await requireAuth();
    const userId = session.user.id;
    const role = session.user.role;

    const ticketWhere = canViewAllTickets(role)
      ? {}
      : { requesterId: userId };

    const [
      totalOpen,
      totalInProgress,
      totalResolved,
      totalClosed,
      assignedToMe,
      byStatus,
      byPriority,
      recentTickets,
      recentActivity,
    ] = await Promise.all([
      // Count by key statuses
      prisma.ticket.count({
        where: { ...ticketWhere, status: { name: "Open" } },
      }),
      prisma.ticket.count({
        where: { ...ticketWhere, status: { name: "In Progress" } },
      }),
      prisma.ticket.count({
        where: { ...ticketWhere, status: { name: "Resolved" } },
      }),
      prisma.ticket.count({
        where: { ...ticketWhere, status: { isClosed: true } },
      }),

      // Assigned to current user
      prisma.ticket.count({
        where: { assignedAgentId: userId, status: { isClosed: false } },
      }),

      // Tickets by status
      prisma.ticket.groupBy({
        by: ["statusId"],
        where: ticketWhere,
        _count: { id: true },
      }),

      // Tickets by priority
      prisma.ticket.groupBy({
        by: ["priorityId"],
        where: { ...ticketWhere, status: { isClosed: false } },
        _count: { id: true },
      }),

      // Recent tickets
      prisma.ticket.findMany({
        where: ticketWhere,
        take: 8,
        orderBy: { createdAt: "desc" },
        include: {
          requester: { select: { id: true, name: true, email: true, image: true } },
          status: { select: { id: true, name: true, color: true } },
          priority: { select: { id: true, name: true, color: true, level: true } },
          category: { select: { id: true, name: true } },
        },
      }),

      // Recent history activity
      prisma.ticketHistory.findMany({
        take: 10,
        orderBy: { createdAt: "desc" },
        include: {
          ticket: { select: { id: true, ticketNumber: true, title: true } },
          changedBy: { select: { id: true, name: true, image: true } },
        },
      }),
    ]);

    // Enrich status/priority groups with names
    const [statusList, priorityList] = await Promise.all([
      prisma.ticketStatus.findMany({ select: { id: true, name: true, color: true } }),
      prisma.ticketPriority.findMany({ select: { id: true, name: true, color: true, level: true } }),
    ]);

    const statusMap = Object.fromEntries(statusList.map((s) => [s.id, s]));
    const priorityMap = Object.fromEntries(priorityList.map((p) => [p.id, p]));

    const byStatusNamed = byStatus
      .filter((s) => s.statusId !== null)
      .map((s) => ({
        ...statusMap[s.statusId!],
        count: s._count.id,
      }));

    const byPriorityNamed = byPriority
      .filter((p) => p.priorityId !== null)
      .map((p) => ({
        ...priorityMap[p.priorityId!],
        count: p._count.id,
      }));

    return NextResponse.json({
      stats: {
        totalOpen,
        totalInProgress,
        totalResolved,
        totalClosed,
        assignedToMe,
      },
      byStatus: byStatusNamed,
      byPriority: byPriorityNamed,
      recentTickets,
      recentActivity,
    });
  } catch (error) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
