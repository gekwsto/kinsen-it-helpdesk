import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildActivityListWhere, buildProjectListWhere, getAccessibleDepartmentSummaries, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ActivityStatus, ActivityPriority, Role } from "@prisma/client";
import { CheckSquare, Plus } from "lucide-react";
import { ActivityList, type SerializedActivity } from "@/components/activities/activity-list";
import { ActivityFilters } from "@/components/activities/activity-filters";
import { ActivityPaginationBar } from "@/components/activities/activity-pagination-bar";
import { ViewToggle } from "@/components/ui/view-toggle";
import { getProgressConfigsForDepartments, resolveProgressPercentOrNull } from "@/lib/activities/activity-progress";
import { getActivityTerminalConfigsForDepartments, resolveActivityTerminal } from "@/lib/status-terminal";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { isActivityOverdue } from "@/lib/overdue";
import {
  buildActivitySearchCondition,
  resolveActivityStatusGroupWhere,
  resolveActivityOverdueWhere,
} from "@/lib/services/activity-query-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";

interface SearchParams {
  page?: string;
  pageSize?: string;
  view?: string;
  search?: string;
  /** Exact ActivityStatus enum value — distinct from statusGroup below. */
  status?: string;
  /** Terminal-status GROUP ("completed" | "incomplete") — see lib/services/activity-query-service.ts. Same semantics as the Projects Dashboard's Completed Activities KPI card. */
  statusGroup?: string;
  /** "true" only — same rule as the Projects Dashboard's Overdue Activities card. */
  overdue?: string;
  projectId?: string;
  assignedUserId?: string;
  unassigned?: string;
  priority?: string;
  departmentId?: string;
  subDepartmentId?: string;
  startDateAfter?: string;
  startDateBefore?: string;
  dueDateAfter?: string;
  dueDateBefore?: string;
}

const ACTIVITY_STATUS_VALUES = new Set<string>(Object.values(ActivityStatus));
const ACTIVITY_PRIORITY_VALUES = new Set<string>(Object.values(ActivityPriority));

/** Strict — rejects anything but exactly YYYY-MM-DD; never a lenient `new Date()` truncation of garbage input. */
function parseStrictDate(raw: string | undefined): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/activities?${canonical.toString()}`;
}

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Same union computes for the sidebar (cache()-wrapped, so this reuses
  // app/(main)/layout.tsx's already-computed result within the same
  // render). The previous canManageProjects(role) pre-gate here was the
  // exact page-level counterpart of the sidebar bug — a hardcoded
  // global-enum check that walled off any user whose activity.view came
  // only from a custom role (global or department), even though the very
  // next check below already asked the correct question.
  const activityNavFlags = await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId);
  const canView = activityNavFlags.canViewActivities;
  if (!canView) redirect("/dashboard");

  // Same union sidebar's "New Activity" link uses — never derived from
  // canView above (VIEW does not imply CREATE).
  const canCreate = activityNavFlags.canCreateActivities;

  const params = await searchParams;

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId && !activeWorkspace.isAllSelected) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Same resolution order as app/(main)/projects/page.tsx: an explicit
  // ?departmentId= wins as an "explicit scoped view," validated against real
  // permission by buildActivityListWhere below (never trusted as-is).
  const effectiveDepartmentId = params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  const scope = await buildActivityListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <CheckSquare className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground text-sm max-w-sm">You don&apos;t have access to that department.</p>
      </div>
    );
  }

  // ── Flat filters (everything except the terminal-status-dependent ones) ──
  const andConditions: Record<string, unknown>[] = [scope as Record<string, unknown>];

  if (params.projectId) andConditions.push({ projectId: params.projectId });
  if (params.subDepartmentId) andConditions.push({ subDepartmentId: params.subDepartmentId });
  if (params.search) andConditions.push(buildActivitySearchCondition(params.search));

  const exactStatus = params.status && ACTIVITY_STATUS_VALUES.has(params.status) ? (params.status as ActivityStatus) : undefined;
  if (exactStatus) andConditions.push({ status: exactStatus });

  const exactPriority = params.priority && ACTIVITY_PRIORITY_VALUES.has(params.priority) ? (params.priority as ActivityPriority) : undefined;
  if (exactPriority) andConditions.push({ priority: exactPriority });

  if (params.unassigned === "true") {
    andConditions.push({ assignedUsers: { none: {} } });
  } else if (params.assignedUserId) {
    andConditions.push({ assignedUsers: { some: { id: params.assignedUserId } } });
  }

  const startDateAfter = parseStrictDate(params.startDateAfter);
  const startDateBefore = parseStrictDate(params.startDateBefore);
  if (startDateAfter || startDateBefore) {
    andConditions.push({ startDate: { ...(startDateAfter ? { gte: startDateAfter } : {}), ...(startDateBefore ? { lte: startDateBefore } : {}) } });
  }
  const dueDateAfter = parseStrictDate(params.dueDateAfter);
  const dueDateBefore = parseStrictDate(params.dueDateBefore);
  if (dueDateAfter || dueDateBefore) {
    andConditions.push({ dueDate: { ...(dueDateAfter ? { gte: dueDateAfter } : {}), ...(dueDateBefore ? { lte: dueDateBefore } : {}) } });
  }

  // A snapshot (spread copy), not a live reference — see
  // app/(main)/projects/page.tsx's identical comment: an earlier
  // terminal-dependent push here must never retroactively change what a
  // LATER resolve* call sees, so multiple terminal-dependent filters stay
  // independently resolved against the same flat base, matching how the
  // Projects Dashboard's own KPI cards are computed independently.
  const flatWhere = { AND: [...andConditions] };

  if (params.overdue === "true") {
    andConditions.push(await resolveActivityOverdueWhere(flatWhere));
  }
  const statusGroup = params.statusGroup === "completed" || params.statusGroup === "incomplete" ? params.statusGroup : undefined;
  if (statusGroup) {
    andConditions.push(await resolveActivityStatusGroupWhere(flatWhere, statusGroup === "completed"));
  }

  const where = { AND: andConditions };

  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);

  const [[activities, totalCount], projectOptions, departmentOptions, userOptions] = await Promise.all([
    prisma.$transaction([
      prisma.projectActivity.findMany({
        where,
        // id as a secondary sort key guarantees fully deterministic
        // pagination even when two activities share the exact same createdAt.
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (requestedPage - 1) * pageSize,
        take: pageSize,
        include: {
          project: { select: { id: true, title: true } },
          department: { select: { id: true, name: true } },
          assignedUsers: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      prisma.projectActivity.count({ where }),
    ]),
    (async () => {
      const projectScope = await buildProjectListWhere(session.user.id, session.user.role, effectiveDepartmentId);
      return prisma.project.findMany({
        where: "denied" in projectScope ? { id: { in: [] as string[] } } : (projectScope as Record<string, unknown>),
        orderBy: { title: "asc" },
        select: { id: true, title: true },
      });
    })(),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "activity.view"),
    prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER, Role.DIRECTOR] }, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const pagination = computePagination(totalCount, requestedPage, pageSize);
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

  const activityDepartmentIds = activities.map((a) => a.departmentId).filter((id): id is string => !!id);
  const progressConfigs = await getProgressConfigsForDepartments(activityDepartmentIds);
  const terminalConfigs = await getActivityTerminalConfigsForDepartments(activityDepartmentIds);
  const statusDisplayConfigs = await getActivityStatusDisplayConfigsForDepartments(activityDepartmentIds);
  const now = new Date();

  const serializedActivities: SerializedActivity[] = activities.map((a) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    statusLabel: resolveActivityStatusDisplay(statusDisplayConfigs, a.departmentId, a.status).label,
    statusColor: resolveActivityStatusDisplay(statusDisplayConfigs, a.departmentId, a.status).color,
    priority: a.priority,
    isCompleted: a.isCompleted,
    startDate: a.startDate?.toISOString() ?? null,
    dueDate: a.dueDate?.toISOString() ?? null,
    progress: resolveProgressPercentOrNull(progressConfigs, a.departmentId, a.status),
    overdue: isActivityOverdue(a.dueDate, resolveActivityTerminal(terminalConfigs, a.departmentId, a.status), now),
    project: a.project,
    department: a.department,
    assignedUsers: a.assignedUsers.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
    })),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activities</h1>
          <p className="text-muted-foreground mt-1">All activities and tasks</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle />
          {canCreate && (
            <Button asChild>
              <Link href="/activities/new">
                <Plus className="h-4 w-4 mr-2" />
                New Activity
              </Link>
            </Button>
          )}
        </div>
      </div>

      <ActivityFilters options={{ projects: projectOptions, users: userOptions, departments: departmentOptions }} />

      {activities.length === 0 ? (
        <div className="text-center py-20">
          <CheckSquare className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            {totalCount === 0 && andConditions.length <= 1 ? "No activities found." : "No activities match your filters."}
          </p>
          {canCreate && andConditions.length <= 1 && (
            <Button asChild className="mt-4" variant="outline">
              <Link href="/activities/new">Create your first activity</Link>
            </Button>
          )}
        </div>
      ) : (
        <>
          <ActivityList activities={serializedActivities} />
          <ActivityPaginationBar pagination={pagination} />
        </>
      )}
    </div>
  );
}
