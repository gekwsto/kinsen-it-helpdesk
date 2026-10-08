import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildActivityListWhere, buildProjectListWhere, getAccessibleDepartmentSummaries, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { CheckSquare, Plus } from "lucide-react";
import { ActivityList, type SerializedActivity } from "@/components/activities/activity-list";
import { ActivityFilters } from "@/components/activities/activity-filters";
import { ActivityPaginationBar } from "@/components/activities/activity-pagination-bar";
import { ActivityListLiveRefresh } from "@/components/activities/activity-list-live-refresh";
import { ViewToggle } from "@/components/ui/view-toggle";
import { getProgressConfigsForDepartments, resolveProgressPercentOrNull } from "@/lib/activities/activity-progress";
import { getActivityTerminalConfigsForDepartments, resolveActivityTerminal } from "@/lib/status-terminal";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { isActivityOverdue } from "@/lib/overdue";
import { computeActivityFinancials } from "@/lib/services/project-financials-service";
import {
  buildActivitySearchCondition,
  resolveActivityStatusGroupWhere,
  resolveActivityOverdueWhere,
  getActivityAssigneeOptions,
} from "@/lib/services/activity-query-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";
import { resolveListSort, type SortKeyDef } from "@/lib/list-sort";

// Whitelist for the List view's clickable column headers (Title, Project,
// Department, Status, Priority, Start, Due, Progress) — see
// app/(main)/projects/page.tsx's own PROJECT_SORT_KEYS for the full
// rationale (never a dynamic `{ [sortBy]: order }`, status/priority reuse
// ActivityStatus/ActivityPriority's own Postgres-enum declaration order —
// already this app's canonical order elsewhere, e.g. ACTIVITY_STATUS_VALUES
// above and the Activity status/priority config admin screens both walk
// Object.values() in this same order). Nullable date/progress columns get
// `nulls: "last"` for a deterministic order in either direction.
const ACTIVITY_SORT_KEYS: Record<string, SortKeyDef> = {
  title: (order) => ({ title: order }),
  // See PROJECT_SORT_KEYS's department entry in app/(main)/projects/page.tsx
  // for why relation fields never take a `nulls` modifier here — project
  // and department below both rely on Postgres's own deterministic
  // per-direction default instead.
  project: (order) => ({ project: { title: order } }),
  department: (order) => ({ department: { name: order } }),
  status: (order) => ({ status: order }),
  priority: (order) => ({ priority: order }),
  startDate: (order) => ({ startDate: { sort: order, nulls: "last" } }),
  dueDate: (order) => ({ dueDate: { sort: order, nulls: "last" } }),
  progress: (order) => ({ progress: order }),
  // Never null, so no `nulls` modifier needed.
  createdAt: (order) => ({ createdAt: order }),
};
const ACTIVITY_DEFAULT_ORDER_BY = [{ createdAt: "desc" as const }, { id: "asc" as const }];

interface SearchParams {
  page?: string;
  pageSize?: string;
  view?: string;
  /** Whitelisted against ACTIVITY_SORT_KEYS below — see lib/list-sort.ts. Only meaningful in List view; clicking a column header sets both. */
  sortBy?: string;
  sortOrder?: string;
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
  /** "request" | "manual" — canonical rule: activity.project.projectRequestId != null (see lib/services/activity-sequence-service.ts's isRequestOriginProject). A standalone Activity (no Project) is "manual", same as every existing isRequestOrigin derivation in this app. */
  origin?: string;
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

  // Origin — canonical rule is activity.project.projectRequestId != null,
  // the SAME relation path every existing isRequestOrigin derivation in
  // this app already uses (activity-new-form.tsx, activity-edit-client.tsx,
  // isRequestOriginProject in activity-sequence-service.ts). A standalone
  // Activity (projectId null) is "manual" too — never treated as
  // request-origin by any of those call sites, so "Manual" here must
  // include it rather than excluding it the way a bare
  // `project: { projectRequestId: null }` relation filter would.
  const origin = params.origin === "request" || params.origin === "manual" ? params.origin : undefined;
  if (origin === "request") andConditions.push({ project: { projectRequestId: { not: null } } });
  else if (origin === "manual") andConditions.push({ OR: [{ projectId: null }, { project: { projectRequestId: null } }] });

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
  const sort = resolveListSort(ACTIVITY_SORT_KEYS, ACTIVITY_DEFAULT_ORDER_BY, params.sortBy, params.sortOrder);

  const [[activities, totalCount], projectOptions, departmentOptions, assigneeOptions] = await Promise.all([
    prisma.$transaction([
      prisma.projectActivity.findMany({
        where,
        // id as a secondary sort key guarantees fully deterministic
        // pagination even when two activities share the exact same primary
        // sort value. sort.orderBy is either this exact canonical default
        // (no/invalid ?sortBy=) or one whitelisted column from
        // ACTIVITY_SORT_KEYS above, always with the same id tie-breaker —
        // see lib/list-sort.ts.
        orderBy: sort.orderBy,
        skip: (requestedPage - 1) * pageSize,
        take: pageSize,
        include: {
          project: { select: { id: true, title: true } },
          department: { select: { id: true, name: true } },
          assignedUsers: { select: { id: true, name: true, email: true, image: true } },
          // Preview-only relations below — cheap, bounded (same cost
          // profile as assignedUsers above), added so the list preview
          // never needs a second per-row fetch. owner/taskType/
          // taskSubType are each a single nullable to-one relation.
          owner: { select: { id: true, name: true, email: true } },
          taskType: { select: { id: true, name: true } },
          taskSubType: { select: { id: true, name: true } },
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
    // Assignee filter-dropdown options — built from the REAL
    // ProjectActivity.assignedUsers relation, scoped by the exact same
    // authorized+department `scope` the main list query above uses as its
    // own base condition (never a disconnected, hardcoded-role User query —
    // see getActivityAssigneeOptions' own doc comment). Independent of
    // `where` (which also carries status/priority/date/etc. filters) so the
    // option list stays stable as those OTHER filters change — only
    // Department narrows it, per spec.
    getActivityAssigneeOptions(scope as Record<string, unknown>),
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

  const serializedActivities: SerializedActivity[] = activities.map((a) => {
    const { estimatedCost, actualCost } = computeActivityFinancials(a);
    return {
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
      createdAt: a.createdAt.toISOString(),
      overdue: isActivityOverdue(a.dueDate, resolveActivityTerminal(terminalConfigs, a.departmentId, a.status), now),
      project: a.project,
      department: a.department,
      assignedUsers: a.assignedUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        image: u.image,
      })),
      description: a.description,
      owner: a.owner,
      expectedStartDate: a.expectedStartDate?.toISOString() ?? null,
      expectedFinishDate: a.expectedFinishDate?.toISOString() ?? null,
      expectedDays: a.expectedDays,
      actualDays: a.actualDays,
      taskType: a.taskType,
      taskSubType: a.taskSubType,
      taskSubTypeCost: a.taskSubTypeCost !== null ? Number(a.taskSubTypeCost) : null,
      estimatedCost: a.taskSubTypeCost !== null && a.expectedDays !== null ? Number(estimatedCost) : null,
      actualCost: a.taskSubTypeCost !== null && a.actualDays !== null ? Number(actualCost) : null,
    };
  });

  return (
    <div className="space-y-6">
      <ActivityListLiveRefresh />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activities</h1>
          <p className="text-muted-foreground mt-1">All activities and tasks</p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle defaultView="list" />
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

      <ActivityFilters options={{ projects: projectOptions, assignees: assigneeOptions, departments: departmentOptions }} />

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
          <ActivityList activities={serializedActivities} defaultView="list" />
          <ActivityPaginationBar pagination={pagination} />
        </>
      )}
    </div>
  );
}
