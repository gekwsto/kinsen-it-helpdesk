import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTicketListWhere, hasAnyFullTicketView } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getProjectsDashboardData } from "@/lib/services/projects-dashboard-service";
import { buildTicketStatusGroupCondition } from "@/lib/services/ticket-status-groups";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { KpiCards } from "@/components/dashboard/kpi-cards";
import { RecentTickets } from "@/components/dashboard/recent-tickets";
import { TicketsByStatusChart } from "@/components/dashboard/tickets-by-status-chart";
import { TicketsByPriorityChart } from "@/components/dashboard/tickets-by-priority-chart";
import { TicketsByCategoryChart } from "@/components/dashboard/tickets-by-category-chart";
import { TicketsOverTimeChart } from "@/components/dashboard/tickets-over-time-chart";
import { DashboardTabs, type DashboardTab } from "@/components/dashboard/dashboard-tabs";
import { ProjectsKpiCards } from "@/components/dashboard/projects-kpi-cards";
import { DashboardPieCard } from "@/components/dashboard/dashboard-pie-card";
import { DashboardBarCard } from "@/components/dashboard/dashboard-bar-card";
import { RecentProjects } from "@/components/dashboard/recent-projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldOff, FolderKanban } from "lucide-react";
import { formatRelative, formatTicketNumber } from "@/lib/utils";
import Link from "next/link";

const TIMELINE_DAYS = 30;

interface SearchParams {
  tab?: string;
}

/**
 * Statuses/priorities/categories are strictly department-owned now (no more
 * global row shared across departments — see the 20260727_retire_global_config
 * migration), so the "All Workspaces" view can legitimately fetch several
 * same-named rows (e.g. every department's own "Open" status) as separate
 * DB rows. Charts key by name, so those duplicates must be merged (summed)
 * before rendering — otherwise React sees two children with the same key
 * (`Encountered two children with the same key` console error) and the pie/
 * bar chart silently drops one of them. A single department's own view never
 * has duplicate names to begin with (its own @@unique([departmentId, name])
 * guarantees that), so this is a no-op there.
 */
function aggregateByName<T extends { name: string; color: string }>(
  rows: T[],
  getValue: (row: T) => number
): Array<{ name: string; color: string; value: number }> {
  const byName = new Map<string, { name: string; color: string; value: number }>();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (existing) existing.value += getValue(row);
    else byName.set(row.name, { name: row.name, color: row.color, value: getValue(row) });
  }
  return Array.from(byName.values());
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) return null;

  const userId = session.user.id;
  const role = session.user.role;
  const params = await searchParams;
  const tab: DashboardTab = params.tab === "projects" ? "projects" : "tickets";

  const activeWorkspace = await getActiveWorkspace(userId, role);
  if (!activeWorkspace.departmentId && !activeWorkspace.isAllSelected) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Projects Dashboard (Part 3) — same page, same route, swapped via the
  // `tab` query param (DashboardTabs). Only the selected tab's data is ever
  // fetched: picking "projects" here returns before any ticket query runs,
  // so the Ticket Dashboard's own queries/behavior below are completely
  // unaffected by this branch existing at all.
  if (tab === "projects") {
    const effectiveDepartmentId = activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId;
    const data = await getProjectsDashboardData(userId, role, effectiveDepartmentId ?? undefined);
    if ("denied" in data) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
          <ShieldOff className="h-12 w-12 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Access denied</h1>
          <p className="text-muted-foreground text-sm max-w-sm">
            You don&apos;t have access to that department.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground mt-1">Projects overview</p>
          </div>
          <DashboardTabs active={tab} />
        </div>

        <ProjectsKpiCards
          totalProjects={data.totalProjects}
          activeProjects={data.activeProjects}
          completedProjects={data.completedProjects}
          overdueProjects={data.overdueProjects}
          totalActivities={data.totalActivities}
          completedActivities={data.completedActivities}
          overdueActivities={data.overdueActivities}
        />

        <div className="grid gap-6 md:grid-cols-2">
          <DashboardPieCard title="Projects by Status" data={data.byStatus} emptyLabel="No projects yet" />
          <DashboardPieCard title="Projects by Priority" data={data.byPriority} emptyLabel="No projects yet" />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <RecentProjects projects={data.recentProjects} />
          </div>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Due Soon</CardTitle>
            </CardHeader>
            <CardContent>
              {data.dueSoonProjects === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active projects due within the next 7 days.
                </p>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50 flex-shrink-0">
                    <FolderKanban className="h-5 w-5 text-amber-600" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{data.dueSoonProjects}</p>
                    <p className="text-xs text-muted-foreground">
                      project{data.dueSoonProjects !== 1 ? "s" : ""} due within 7 days
                    </p>
                  </div>
                </div>
              )}
              <Button asChild variant="outline" size="sm" className="mt-4 w-full">
                <Link href="/projects">View all projects</Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <DashboardBarCard title="Projects by Owner" data={data.byOwner} emptyLabel="No projects yet" tooltipLabel="Projects" />
      </div>
    );
  }

  const isPersonalView = !(await hasAnyFullTicketView(userId, role));

  const scope = await buildTicketListWhere(
    userId,
    role,
    activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId
  );
  const ticketWhere = "denied" in scope ? { id: { in: [] as string[] } } : scope;
  const recentActivityWhere = { ticket: ticketWhere };

  const timelineStart = new Date(Date.now() - TIMELINE_DAYS * 24 * 60 * 60 * 1000);

  const [
    totalCount,
    openCount,
    inProgressCount,
    closedCount,
    emailCount,
    byStatus,
    byPriority,
    byCategory,
    rawTimeline,
    recentTickets,
    recentActivity,
  ] = await Promise.all([
    // KPI counts — each condition comes from buildTicketStatusGroupCondition,
    // the exact same function the All Tickets list's `?status=` filter uses,
    // so a card's count and what clicking it shows can never disagree.
    prisma.ticket.count({ where: ticketWhere }),
    prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition("open") } }),
    prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition("in_progress") } }),
    prisma.ticket.count({ where: { ...ticketWhere, ...buildTicketStatusGroupCondition("closed") } }),
    prisma.ticket.count({ where: { ...ticketWhere, source: "EMAIL" } }),

    // Chart: by status — scoped to the active workspace's own department.
    // Every status/priority/category is department-owned now (no more
    // global fallback), so an unscoped fetch would show every department's
    // identically-named rows as separate (mostly zero-count) chart entries.
    // "All Workspaces" has no single department to scope to, so it still
    // shows every row — a known limitation, not fixed here.
    prisma.ticketStatus.findMany({
      where: { isActive: true, ...(activeWorkspace.departmentId ? { departmentId: activeWorkspace.departmentId } : {}) },
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
      where: { isActive: true, ...(activeWorkspace.departmentId ? { departmentId: activeWorkspace.departmentId } : {}) },
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
      where: { isActive: true, ...(activeWorkspace.departmentId ? { departmentId: activeWorkspace.departmentId } : {}) },
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

    // Recent activity (scoped to own tickets for non-admin users)
    prisma.ticketHistory.findMany({
      where: recentActivityWhere,
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

  // Serialise chart data — aggregated by name (see aggregateByName above),
  // since "All Workspaces" can legitimately return several departments' own
  // same-named status/priority/category rows as separate DB rows now.
  const statusChartData = aggregateByName(byStatus, (s) => s._count.tickets);

  const priorityChartData = aggregateByName(byPriority, (p) => p._count.tickets);

  const categoryChartData = aggregateByName(byCategory, (c) => c._count.tickets).map((c) => ({
    name: c.name,
    count: c.value,
    color: c.color,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {isPersonalView ? "My Dashboard" : "Dashboard"}
          </h1>
          <p className="text-muted-foreground mt-1">
            {isPersonalView
              ? "Your personal ticket overview"
              : `Welcome back, ${session.user.name?.split(" ")[0]}`}
          </p>
        </div>
        <DashboardTabs active={tab} />
      </div>

      {/* Row 1 — KPI cards */}
      <KpiCards
        total={totalCount}
        open={openCount}
        inProgress={inProgressCount}
        closed={closedCount}
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
