import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTicketListWhere, hasAnyFullTicketView, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getProjectsDashboardData } from "@/lib/services/projects-dashboard-service";
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
import { ShieldOff, FolderKanban, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
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
        <PageHeader title="Dashboard" description="Projects and activities overview" action={<DashboardTabs active={tab} />} />

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
  // cache()-wrapped — the (main) layout already computed it for the sidebar.
  const { canViewClosedTickets, canCreateTickets } = await getNavVisibilityFlags(userId, role, session.user.customRoleId);

  const scope = await buildTicketListWhere(
    userId,
    role,
    activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId
  );
  const ticketWhere = "denied" in scope ? { id: { in: [] as string[] } } : scope;
  const recentActivityWhere = { ticket: ticketWhere };

  const timelineStart = new Date(Date.now() - TIMELINE_DAYS * 24 * 60 * 60 * 1000);

  // KPI cards: each count uses exactly the conditions of the list its card
  // opens, and each href carries the active workspace's departmentId —
  // All Tickets deliberately ignores the workspace (it shows the union of
  // every accessible department), so without an explicit ?departmentId= a
  // card showing 4 would open a list of 30. Open/Unassigned/From Email
  // mirror All Tickets' default scope (non-closed, never-cancelled);
  // Closed mirrors /tickets/closed (closed status OR cancelled).
  const workspaceDepartmentId = activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId ?? undefined;
  const workspaceName = activeWorkspace.departments.find((d) => d.id === workspaceDepartmentId)?.name;
  const openListWhere = { AND: [ticketWhere, { cancelReasonId: null }, { status: { isClosed: false } }] };
  const closedListWhere = { AND: [ticketWhere, { OR: [{ status: { isClosed: true } }, { cancelReasonId: { not: null } }] }] };
  const listHref = (path: string, extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ ...(workspaceDepartmentId ? { departmentId: workspaceDepartmentId } : {}), ...extra }).toString();
    return qs ? `${path}?${qs}` : path;
  };

  const [
    openCount,
    unassignedCount,
    emailCount,
    closedCount,
    myRequestsCount,
    unprioritisedCount,
    byStatus,
    byPriority,
    byCategory,
    rawTimeline,
    recentTickets,
    recentActivity,
  ] = await Promise.all([
    // KPI counts — see openListWhere/closedListWhere above.
    isPersonalView ? 0 : prisma.ticket.count({ where: openListWhere }),
    isPersonalView ? 0 : prisma.ticket.count({ where: { AND: [openListWhere, { assignedAgentId: null }] } }),
    isPersonalView ? 0 : prisma.ticket.count({ where: { AND: [openListWhere, { source: "EMAIL" }] } }),
    prisma.ticket.count({ where: closedListWhere }),
    isPersonalView ? prisma.ticket.count({ where: { requesterId: userId } }) : 0,
    isPersonalView ? 0 : prisma.ticket.count({ where: { AND: [openListWhere, { priorityId: null }] } }),

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
        isClosed: true,
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
        // Same "not closed" definition as the KPI strip (openListWhere), so the
        // rows plus the "No priority" count below add up to that number.
        _count: { select: { tickets: { where: { AND: [openListWhere] } } } },
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
        status: { select: { id: true, name: true, color: true, isClosed: true } },
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
  const statusChartData = aggregateByName(byStatus, (s) => s._count.tickets).map((row) => ({
    ...row,
    closed: byStatus.find((s) => s.name === row.name)?.isClosed,
  }));

  const priorityChartData = aggregateByName(byPriority, (p) => p._count.tickets).map((row) => ({
    ...row,
    level: byPriority.find((p) => p.name === row.name)?.level,
  }));

  const categoryChartData = aggregateByName(byCategory, (c) => c._count.tickets).map((c) => ({
    name: c.name,
    count: c.value,
    color: c.color,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={isPersonalView ? "My Dashboard" : "Dashboard"}
        description={
          isPersonalView
            ? "Your requests at a glance"
            : activeWorkspace.isAllSelected
              ? "Tickets across all your departments"
              : `Tickets in ${workspaceName ?? "your current workspace"} (your current workspace)`
        }
        action={
          <>
            <DashboardTabs active={tab} />
            {canCreateTickets && (
              <Button asChild>
                <Link href="/tickets/new">
                  <Plus className="h-4 w-4" />
                  New Ticket
                </Link>
              </Button>
            )}
          </>
        }
      />

      {/* Row 1 — KPI cards */}
      <KpiCards
        cards={
          isPersonalView
            ? [
                { key: "myRequests" as const, count: myRequestsCount, href: "/tickets/created-by-me" },
                // /tickets/closed bounces anyone without ticket.closed.view back here.
                ...(canViewClosedTickets ? [{ key: "closed" as const, count: closedCount, href: "/tickets/closed" }] : []),
              ]
            : [
                { key: "open" as const, count: openCount, href: listHref("/tickets") },
                { key: "unassigned" as const, count: unassignedCount, href: listHref("/tickets", { unassigned: "true" }) },
                { key: "fromEmail" as const, count: emailCount, href: listHref("/tickets", { source: "EMAIL" }) },
                ...(canViewClosedTickets ? [{ key: "closed" as const, count: closedCount, href: listHref("/tickets/closed") }] : []),
              ]
        }
      />

      {/* Recent tickets + Recent activity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
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
                    <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 mt-2 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium">{a.changedBy?.name ?? "System"}</span>{" "}
                      <span className="text-muted-foreground">{a.description}</span>{" "}
                      on{" "}
                      <Link
                        href={`/tickets/${a.ticket.id}`}
                        className="font-medium text-link hover:underline"
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

      {/* Analysis comes after the work itself; requesters don't need charts about their own few tickets. */}
      {!isPersonalView && (
        <>
      {/* Status + Priority */}
      <div className="grid gap-6 md:grid-cols-2">
        <TicketsByStatusChart data={statusChartData} />
        <TicketsByPriorityChart data={priorityChartData} unprioritised={unprioritisedCount} />
      </div>

      {/* Category + Timeline */}
      <div className="grid gap-6 md:grid-cols-2">
        <TicketsByCategoryChart data={categoryChartData} />
        <TicketsOverTimeChart data={timelineData} days={TIMELINE_DAYS} />
      </div>

        </>
      )}
    </div>
  );
}
