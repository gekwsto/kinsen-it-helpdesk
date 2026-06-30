import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canViewAllTickets } from "@/lib/permissions";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { RecentTickets } from "@/components/dashboard/recent-tickets";
import { TicketsByStatusChart } from "@/components/dashboard/tickets-by-status-chart";
import { TicketsByPriorityChart } from "@/components/dashboard/tickets-by-priority-chart";
import { TicketsByCategoryChart } from "@/components/dashboard/tickets-by-category-chart";
import { TicketsOverTimeChart } from "@/components/dashboard/tickets-over-time-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative, formatTicketNumber } from "@/lib/utils";
import Link from "next/link";

const TIMELINE_DAYS = 30;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) return null;

  const userId = session.user.id;
  const role = session.user.role;
  const ticketWhere = canViewAllTickets(role) ? {} : { requesterId: userId };

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const timelineStart = new Date(Date.now() - TIMELINE_DAYS * 24 * 60 * 60 * 1000);

  const [
    totalCount,
    openCount,
    inProgressCount,
    closedCount,
    overdueCount,
    emailCount,
    byStatus,
    byPriority,
    byCategory,
    rawTimeline,
    recentTickets,
    recentActivity,
  ] = await Promise.all([
    // KPI counts
    prisma.ticket.count({ where: ticketWhere }),
    prisma.ticket.count({ where: { ...ticketWhere, status: { isClosed: false } } }),
    prisma.ticket.count({
      where: { ...ticketWhere, status: { name: { contains: "Progress", mode: "insensitive" } } },
    }),
    prisma.ticket.count({ where: { ...ticketWhere, status: { isClosed: true } } }),
    prisma.ticket.count({
      where: { ...ticketWhere, status: { isClosed: false }, createdAt: { lt: sevenDaysAgo } },
    }),
    prisma.ticket.count({ where: { ...ticketWhere, source: "EMAIL" } }),

    // Chart: by status
    prisma.ticketStatus.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        color: true,
        _count: { select: { tickets: { where: ticketWhere } } },
      },
      orderBy: { order: "asc" },
    }),

    // Chart: by priority (open tickets only)
    prisma.ticketPriority.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        color: true,
        level: true,
        _count: { select: { tickets: { where: { ...ticketWhere, status: { isClosed: false } } } } },
      },
      orderBy: { level: "desc" },
    }),

    // Chart: by category
    prisma.ticketCategory.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        color: true,
        _count: { select: { tickets: { where: ticketWhere } } },
      },
      orderBy: { name: "asc" },
    }),

    // Timeline: raw creation dates
    prisma.ticket.findMany({
      where: { ...ticketWhere, createdAt: { gte: timelineStart } },
      select: { createdAt: true },
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

    // Recent activity
    prisma.ticketHistory.findMany({
      take: 6,
      orderBy: { createdAt: "desc" },
      include: {
        ticket: { select: { id: true, ticketNumber: true, title: true } },
        changedBy: { select: { id: true, name: true, image: true } },
      },
    }),
  ]);

  // Build day-by-day timeline
  const dayMap = new Map<string, number>();
  for (const t of rawTimeline) {
    const key = t.createdAt.toISOString().split("T")[0];
    dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
  }
  const timelineData = Array.from({ length: TIMELINE_DAYS }, (_, i) => {
    const d = new Date(Date.now() - (TIMELINE_DAYS - 1 - i) * 24 * 60 * 60 * 1000);
    const key = d.toISOString().split("T")[0];
    return { date: key, count: dayMap.get(key) ?? 0 };
  });

  // Serialise chart data
  const statusChartData = byStatus.map((s) => ({
    name: s.name,
    value: s._count.tickets,
    color: s.color,
  }));

  const priorityChartData = byPriority.map((p) => ({
    name: p.name,
    value: p._count.tickets,
    color: p.color,
  }));

  const categoryChartData = byCategory.map((c) => ({
    name: c.name,
    count: c._count.tickets,
    color: c.color,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Welcome back, {session.user.name?.split(" ")[0]}
        </p>
      </div>

      {/* Row 1 — KPI cards */}
      <KpiCards
        total={totalCount}
        open={openCount}
        inProgress={inProgressCount}
        closed={closedCount}
        overdue={overdueCount}
        emailCreated={emailCount}
      />

      {/* Row 2 — Status + Priority pie/donut */}
      <div className="grid gap-6 md:grid-cols-2">
        <TicketsByStatusChart data={statusChartData} />
        <TicketsByPriorityChart data={priorityChartData} />
      </div>

      {/* Row 3 — Category bar + Timeline line */}
      <div className="grid gap-6 md:grid-cols-2">
        <TicketsByCategoryChart data={categoryChartData} />
        <TicketsOverTimeChart data={timelineData} days={TIMELINE_DAYS} />
      </div>

      {/* Row 4 — Recent tickets + Recent activity */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentTickets tickets={recentTickets as any} />
        </div>

        {recentActivity.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentActivity.map((a) => (
                  <div key={a.id} className="flex items-start gap-3 text-sm">
                    <div className="h-1.5 w-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{a.changedBy?.name ?? "System"}</span>{" "}
                      <span className="text-muted-foreground">{a.description}</span>{" "}
                      on{" "}
                      <Link
                        href={`/tickets/${a.ticket.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {formatTicketNumber(a.ticket.ticketNumber)}
                      </Link>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatRelative(a.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
