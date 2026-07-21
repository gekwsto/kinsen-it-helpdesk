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
import {
  getAssignableUsersForActivity,
  getAssignableUsersForProject,
  type AssignableUserSummary,
} from "@/lib/services/assignment-eligibility-service";
import { comparePriorityDesc } from "@/lib/activity-priority";

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
  /** Always one of ActivityPriority's values — ProjectActivity.priority is non-nullable (@default(MEDIUM)) — typed as a plain string here since it crosses the same server/client boundary status already does. */
  priority: string;
  start: string | null;
  end: string | null;
  isFallbackDate: boolean;
  assignedUserIds: string[];
}

/**
 * Rows for the timeline — the union of project- and activity-assignable
 * users (a resource useful for either kind of work), deduped by id, each
 * tagged with which check(s) it passed. Narrowed to a sub-department's
 * active members when one is selected.
 */
export async function getResourcePlanningResources(
  departmentId: string,
  subDepartmentId?: string | null
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
  resourceIds: string[];
  rangeStart: Date;
  rangeEnd: Date;
}

/**
 * Scheduled work for the given resources — one query (department/
 * subdepartment/project/status/priority/assignee scoped, no date predicate
 * at the DB level), then bucketed here: `unscheduled` (no start/due date at
 * all — always returned, independent of the range) vs `events` (has usable
 * dates AND overlaps [rangeStart, rangeEnd]) vs silently dropped (has
 * dates, but outside the range — genuinely filtered out, not returned in
 * either bucket). This IS the server-side date-range filter — it happens
 * here, not in a client component, just not as a DB WHERE predicate (a
 * plain overlap scan is simpler/less fragile than the Prisma OR-clause
 * equivalent at this dataset's expected size — one department's
 * activities, not company-wide).
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
): Promise<{ events: ResourceEvent[]; unscheduled: ResourceEvent[] }> {
  const { departmentId, subDepartmentId, projectId, status, priority, resourceIds, rangeStart, rangeEnd } = filters;

  if (resourceIds.length === 0) return { events: [], unscheduled: [] };

  const activities = await prisma.projectActivity.findMany({
    where: {
      departmentId,
      ...(subDepartmentId ? { subDepartmentId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      assignedUsers: { some: { id: { in: resourceIds } } },
    },
    include: {
      assignedUsers: { select: { id: true } },
      project: { select: { id: true, title: true } },
    },
    orderBy: [{ priority: "desc" }, { startDate: "asc" }],
  });

  const events: ResourceEvent[] = [];
  const unscheduled: ResourceEvent[] = [];

  for (const a of activities) {
    const start = a.startDate ?? a.dueDate;
    const end = a.dueDate ?? a.startDate;
    const assignedUserIds = a.assignedUsers.map((u) => u.id);
    const base = {
      id: a.id,
      title: a.title,
      projectId: a.project?.id ?? null,
      projectTitle: a.project?.title ?? null,
      status: a.status,
      priority: a.priority,
      assignedUserIds,
    };

    if (!start || !end) {
      unscheduled.push({ ...base, start: null, end: null, isFallbackDate: false });
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

  return { events, unscheduled };
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
 * resourcePlanning.view scope check for the requested department, then the
 * resources and events for it. Returns `{ denied: true }` rather than
 * throwing so callers can render a clean access-denied state.
 */
export async function getResourcePlanningData(
  viewer: { userId: string; role: Role; customRoleId?: string | null },
  filters: ResourcePlanningDataFilters
): Promise<ResourcePlanningDataResult> {
  const scope = await buildResourcePlanningWhere(viewer.userId, viewer.role, filters.departmentId);
  if ("denied" in scope) return { denied: true };

  const resources = await getResourcePlanningResources(filters.departmentId, filters.subDepartmentId);
  const resourceIds = resources.map((r) => r.id);

  const { events, unscheduled } = await getResourcePlanningEvents({
    departmentId: filters.departmentId,
    subDepartmentId: filters.subDepartmentId,
    projectId: filters.projectId,
    status: filters.status,
    priority: filters.priority,
    resourceIds,
    rangeStart: filters.rangeStart,
    rangeEnd: filters.rangeEnd,
  });

  return { denied: false, resources, events, unscheduled };
}
