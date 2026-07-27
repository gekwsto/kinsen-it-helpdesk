/**
 * Central service backing /projects/resource-planning — the one place
 * scope/resource/event logic lives so both the page and tests call the same
 * code (see the architecture plan). Deliberately does NOT relocate
 * buildResourcePlanningWhere out of department-scope-service.ts — it stays
 * there alongside buildProjectListWhere/buildActivityListWhere (the
 * scoping-function family it belongs to); this file imports and orchestrates
 * it instead of duplicating it.
 */
import { prisma } from "@/lib/prisma";
import { Role, ActivityStatus, ActivityPriority } from "@prisma/client";
import { buildResourcePlanningWhere } from "@/lib/services/department-scope-service";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import {
  getAssignableUsersForActivity,
  getAssignableUsersForProject,
  type AssignableUserSummary,
} from "@/lib/services/assignment-eligibility-service";
import { comparePriorityDesc } from "@/lib/activity-priority";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";

export interface ResourcePlanningResource extends AssignableUserSummary {
  /** Which assignability check(s) this resource qualified through — shown as a badge only when it's not both. */
  assignableFor: Array<"activity" | "project">;
}

export interface ResourceEvent {
  id: string;
  title: string;
  projectId: string | null;
  projectTitle: string | null;
  status: string;
  /** This activity's department-resolved status display label — see lib/services/activity-status-config.ts. Never a hardcoded map. */
  statusLabel: string;
  /** This activity's department-resolved status color (#RRGGBB). */
  statusColor: string;
  /** Always one of ActivityPriority's values — ProjectActivity.priority is non-nullable (@default(MEDIUM)) — typed as a plain string here since it crosses the same server/client boundary status already does. */
  priority: string;
  start: string | null;
  end: string | null;
  isFallbackDate: boolean;
  assignedUserIds: string[];
  /** Why this landed in `unscheduled` instead of `events` — null for anything in `events`. Two genuinely different reasons ("no dates" vs "no assignee") share the one Unscheduled bucket (see getResourcePlanningEvents) so the panel can still show accurate copy per item instead of a blanket message that's wrong for half of them. */
  unscheduledReason: "no-dates" | "no-assignee" | null;
}

/**
 * Rows for the timeline — the union of project- and activity-assignable
 * users (a resource useful for either kind of work, deduped by id, each
 * tagged with which check(s) it passed) PLUS anyone in `extraAssignedUserIds`
 * who isn't already in that union — real, current assignees of in-scope
 * activities whose role/membership has since changed and no longer grants
 * `activity.assignable`/`project.assignable`. Their row exists so their
 * actual assigned work is never hidden by a permission snapshot that no
 * longer matches (see getResourcePlanningData, which threads
 * getResourcePlanningEvents' own assignedUserIds output back in here) —
 * they're tagged `assignableFor: []` so the timeline still won't offer them
 * as a valid NEW drag-and-drop reassignment target (the PATCH route itself
 * also re-validates this via userHasAssignablePermissionForEntity either
 * way). Narrowed to a sub-department's active members when one is selected
 * — applied to the extras too, for the same reason it applies to the core
 * assignable set: a sub-department-scoped view shouldn't grow a row for
 * someone outside that sub-team just because of a data anomaly.
 */
export async function getResourcePlanningResources(
  departmentId: string,
  subDepartmentId?: string | null,
  extraAssignedUserIds: string[] = []
): Promise<ResourcePlanningResource[]> {
  const [activityAssignable, projectAssignable] = await Promise.all([
    getAssignableUsersForActivity(departmentId),
    getAssignableUsersForProject(departmentId),
  ]);

  const byId = new Map<string, ResourcePlanningResource>();
  for (const u of activityAssignable) {
    byId.set(u.id, { ...u, assignableFor: ["activity"] });
  }
  for (const u of projectAssignable) {
    const existing = byId.get(u.id);
    if (existing) {
      if (!existing.assignableFor.includes("project")) existing.assignableFor.push("project");
    } else {
      byId.set(u.id, { ...u, assignableFor: ["project"] });
    }
  }

  const missingIds = extraAssignedUserIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const extraUsers = await prisma.user.findMany({
      where: { id: { in: missingIds }, isActive: true },
      select: { id: true, name: true, email: true, image: true },
    });
    for (const u of extraUsers) {
      byId.set(u.id, { ...u, assignableFor: [] });
    }
  }

  let resources = Array.from(byId.values());

  if (subDepartmentId) {
    const memberships = await prisma.subDepartmentMembership.findMany({
      where: { subDepartmentId, departmentId, isActive: true },
      select: { userId: true },
    });
    const allowedIds = new Set(memberships.map((m) => m.userId));
    resources = resources.filter((r) => allowedIds.has(r.id));
  }

  return resources.sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

export interface ResourcePlanningEventFilters {
  departmentId: string;
  subDepartmentId?: string | null;
  projectId?: string | null;
  status?: ActivityStatus | null;
  priority?: ActivityPriority | null;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface ResourcePlanningEventsResult {
  events: ResourceEvent[];
  unscheduled: ResourceEvent[];
  /** Every distinct user id assigned to at least one in-scope activity (scheduled or unscheduled) — fed back into getResourcePlanningResources so a row always exists for real assigned work, even for a user who no longer holds activity.assignable/project.assignable. See getResourcePlanningData. */
  assignedUserIds: string[];
}

/**
 * ALL activities in scope (department/subdepartment/project/status/priority
 * — no assignee filter at the DB level at all), then bucketed here:
 * `unscheduled` (no start/due date, OR no assignee at all — neither can
 * ever be placed on a resource row, so both are "always returned,
 * independent of the range," distinguished by `unscheduledReason` for the
 * UI) vs `events` (has an assignee AND usable dates AND overlaps
 * [rangeStart, rangeEnd]) vs silently dropped (has an assignee and dates,
 * but outside the range — genuinely filtered out, not returned in either
 * bucket). This IS the server-side date-range filter — it happens here,
 * not in a client component, just not as a DB WHERE predicate (a plain
 * overlap scan is simpler/less fragile than the Prisma OR-clause
 * equivalent at this dataset's expected size — one department's
 * activities, not company-wide).
 *
 * Deliberately does NOT filter by `assignedUsers` at all (an earlier
 * version took a `resourceIds` list — the "currently assignable" users —
 * and required `assignedUsers: { some: { id: { in: resourceIds } } }`;
 * that's a real bug, not a scoping choice: whether an activity is
 * *currently assignable* to someone and whether it's *already assigned* to
 * them are different questions, and conflating them silently dropped any
 * activity assigned to a user whose role changed after the fact, AND any
 * activity with zero assignees at all — an empty relation can never
 * satisfy `some`, so unassigned activities vanished unconditionally).
 * Visibility on the grid is a resource-ROW question (does this user have a
 * row to render into), not a query-scope question — see
 * getResourcePlanningResources, which is guaranteed a row for every id in
 * this function's own `assignedUserIds` output.
 *
 * Both buckets are sorted by canonical priority (URGENT..LOW, see
 * lib/activity-priority.ts) first, then start date / title / id as a
 * deterministic tiebreak — the DB `orderBy` below already gets this mostly
 * right for free (Postgres orders a native enum by its declared ordinal,
 * and the schema declares ActivityPriority LOW..URGENT ascending, so
 * `desc` yields URGENT first), but the explicit sort here is what actually
 * guarantees it: correctness shouldn't depend on a reader recognizing that
 * enum-ordinal detail, and this is also the single source of truth
 * ResourceTimeline's per-resource-row lane order (one lane per activity,
 * most urgent on top) needs to match.
 */
export async function getResourcePlanningEvents(
  filters: ResourcePlanningEventFilters
): Promise<ResourcePlanningEventsResult> {
  const { departmentId, subDepartmentId, projectId, status, priority, rangeStart, rangeEnd } = filters;

  // ProjectActivity.departmentId is nullable — rows predating department
  // scoping (or created by a path that never set it, e.g. seed/import data)
  // sit with departmentId: null. Every OTHER department-scoped list query
  // in this app (buildEntityListWhere, backing buildProjectListWhere/
  // buildActivityListWhere/ticket lists) folds those legacy rows into
  // whichever department is configured as the app's default legacy
  // department (DEFAULT_DEPARTMENT_SLUG, "IT Department" here) — this query
  // was missing that exact fallback, so a legacy activity a viewer had
  // correctly assigned dates/assignees on (visible everywhere else in the
  // app) simply never matched a strict `departmentId: departmentId` filter
  // and was invisible on the Resource Planning grid.
  const legacyDepartmentId = await getDefaultLegacyDepartmentId();
  const departmentWhere =
    legacyDepartmentId && legacyDepartmentId === departmentId
      ? { OR: [{ departmentId }, { departmentId: null }] }
      : { departmentId };

  const activities = await prisma.projectActivity.findMany({
    where: {
      ...departmentWhere,
      ...(subDepartmentId ? { subDepartmentId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
    },
    include: {
      assignedUsers: { select: { id: true } },
      project: { select: { id: true, title: true } },
    },
    orderBy: [{ priority: "desc" }, { startDate: "asc" }],
  });

  const events: ResourceEvent[] = [];
  const unscheduled: ResourceEvent[] = [];
  const assignedUserIds = new Set<string>();

  // Resource Planning is always scoped to exactly one department (this
  // function's own `departmentId` filter), so one small map covers every
  // activity here — including legacy departmentId:null rows, which the
  // resolver already folds into this same department when it's the app's
  // default legacy department (matching departmentWhere's own fallback above).
  const statusDisplayConfigs = await getActivityStatusDisplayConfigsForDepartments([departmentId]);

  for (const a of activities) {
    const start = a.startDate ?? a.dueDate;
    const end = a.dueDate ?? a.startDate;
    const activityAssignedUserIds = a.assignedUsers.map((u) => u.id);
    for (const id of activityAssignedUserIds) assignedUserIds.add(id);
    const statusDisplay = resolveActivityStatusDisplay(statusDisplayConfigs, a.departmentId, a.status);
    const base = {
      id: a.id,
      title: a.title,
      projectId: a.project?.id ?? null,
      projectTitle: a.project?.title ?? null,
      status: a.status,
      statusLabel: statusDisplay.label,
      statusColor: statusDisplay.color,
      priority: a.priority,
      assignedUserIds: activityAssignedUserIds,
    };

    // No assignee at all -> there is no resource row it could ever render
    // into, structurally the same reason a date-less activity can't be
    // placed on the grid either. Always surfaced (not range-filtered),
    // same as the no-dates case below.
    if (activityAssignedUserIds.length === 0) {
      unscheduled.push({ ...base, start: start?.toISOString() ?? null, end: end?.toISOString() ?? null, isFallbackDate: false, unscheduledReason: "no-assignee" });
      continue;
    }

    if (!start || !end) {
      unscheduled.push({ ...base, start: null, end: null, isFallbackDate: false, unscheduledReason: "no-dates" });
      continue;
    }

    if (end < rangeStart || start > rangeEnd) continue; // outside the selected window — dropped, not shown anywhere

    events.push({
      ...base,
      start: start.toISOString(),
      end: end.toISOString(),
      // True when only one of startDate/dueDate was actually set — the
      // other side is a single-day fallback, not a real range.
      isFallbackDate: !a.startDate || !a.dueDate,
      unscheduledReason: null,
    });
  }

  const byPriorityThenTitle = (a: ResourceEvent, b: ResourceEvent) =>
    comparePriorityDesc(a.priority, b.priority) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

  events.sort(
    (a, b) =>
      comparePriorityDesc(a.priority, b.priority) ||
      new Date(a.start!).getTime() - new Date(b.start!).getTime() ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id)
  );
  unscheduled.sort(byPriorityThenTitle);

  return { events, unscheduled, assignedUserIds: Array.from(assignedUserIds) };
}

export interface ResourcePlanningDataFilters {
  /** Always required — Resource Planning operates on exactly one resolved department; the caller (the page) resolves which one before calling this. */
  departmentId: string;
  subDepartmentId?: string | null;
  projectId?: string | null;
  status?: ActivityStatus | null;
  priority?: ActivityPriority | null;
  rangeStart: Date;
  rangeEnd: Date;
}

export type ResourcePlanningDataResult =
  | { denied: true }
  | { denied: false; resources: ResourcePlanningResource[]; events: ResourceEvent[]; unscheduled: ResourceEvent[] };

/**
 * The single entry point the page (and tests) call — resolves the
 * resourcePlanning.view scope check for the requested department, then
 * events and resources for it, IN THAT ORDER: events must resolve first so
 * their real assignedUserIds (regardless of current assignable-permission
 * standing) can be threaded into getResourcePlanningResources, guaranteeing
 * a row exists for every actual assignee, not just the "currently
 * assignable" ones. Returns `{ denied: true }` rather than throwing so
 * callers can render a clean access-denied state.
 */
export async function getResourcePlanningData(
  viewer: { userId: string; role: Role; customRoleId?: string | null },
  filters: ResourcePlanningDataFilters
): Promise<ResourcePlanningDataResult> {
  const scope = await buildResourcePlanningWhere(viewer.userId, viewer.role, filters.departmentId);
  if ("denied" in scope) return { denied: true };

  const { events, unscheduled, assignedUserIds } = await getResourcePlanningEvents({
    departmentId: filters.departmentId,
    subDepartmentId: filters.subDepartmentId,
    projectId: filters.projectId,
    status: filters.status,
    priority: filters.priority,
    rangeStart: filters.rangeStart,
    rangeEnd: filters.rangeEnd,
  });

  const resources = await getResourcePlanningResources(filters.departmentId, filters.subDepartmentId, assignedUserIds);

  return { denied: false, resources, events, unscheduled };
}
