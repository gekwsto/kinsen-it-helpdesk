/**
 * Shared Prisma `where`-condition builders for the Project/ProjectActivity
 * "terminal status" concept — used by BOTH the Projects Dashboard's KPI
 * counts (lib/services/projects-dashboard-service.ts) and the All Projects
 * list's URL-driven filters (app/(main)/projects/page.tsx), so a dashboard
 * card's number and what its link actually shows can never silently
 * disagree. Every function here calls the exact same low-level primitives
 * the dashboard already uses (resolveProjectTerminal/resolveActivityTerminal
 * from lib/status-terminal.ts, isOverdue's SQL-pushable prefilter from
 * lib/overdue.ts) — never a re-derived or approximated copy of that logic.
 *
 * Terminal-ness is per (departmentId, status) — see ProjectStatusConfig/
 * ActivityStatusConfig in prisma/schema.prisma — so it cannot be expressed
 * as a single static Prisma `where` clause. Instead: a bounded `groupBy`
 * discovers exactly which (departmentId, status) combinations exist among
 * rows already matching every OTHER active filter, each combination's
 * terminal-ness is resolved via the same bulk-loaded config map the
 * dashboard uses, and only the matching combinations are turned into an
 * explicit `OR` list — bounded by "distinct departments × distinct status
 * values actually present" (at most 5 project statuses / 4-ish activity
 * statuses per department), never by row count. No project/activity rows
 * are ever loaded into memory to be filtered client-side.
 */
import { prisma } from "@/lib/prisma";
import {
  getProjectTerminalConfigsForDepartments,
  getActivityTerminalConfigsForDepartments,
  resolveProjectTerminal,
  resolveActivityTerminal,
} from "@/lib/status-terminal";
import { startOfTodayUtc } from "@/lib/overdue";
import { buildProjectListWhere } from "@/lib/services/department-scope-service";
import { resolveListSort, type SortKeyDef } from "@/lib/list-sort";
import { ProjectStatus, type Role } from "@prisma/client";

const NO_MATCH: Record<string, unknown> = { id: { in: [] as string[] } };

export interface PersonFilterOption {
  id: string;
  name: string | null;
}

/**
 * Owner/Member filter-dropdown options for the All Projects list — built
 * from the ACTUAL relation each dropdown filters (Project.owner /
 * Project.members), scoped by the exact same `scopeWhere` the main list
 * query's own authorization (buildProjectListWhere) already resolved —
 * never a disconnected `User.role` query. Queried FROM the User side via
 * the ownedProjects/projectMemberships back-relations (see prisma/schema.prisma)
 * so deduplication is a property of the SQL itself (one row per matching
 * User — an `EXISTS` correlated subquery under the hood, never a
 * `distinct` pass over loaded rows): a user can own/belong to many
 * projects in scope and still appears exactly once. Naturally supports any
 * CustomRole user, and an inactive user is still included as long as
 * they're still genuinely attached to a project inside `scopeWhere` —
 * `isActive` is deliberately never filtered on here, since "historical/
 * inactive users remain filterable if still attached to a visible entity"
 * is a requirement, not an oversight.
 */
export async function getProjectOwnerOptions(scopeWhere: Record<string, unknown>): Promise<PersonFilterOption[]> {
  return prisma.user.findMany({
    where: { ownedProjects: { some: scopeWhere as any } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** See getProjectOwnerOptions's doc comment — same rationale, via the Project.members (many-to-many) relation. */
export async function getProjectMemberOptions(scopeWhere: Record<string, unknown>): Promise<PersonFilterOption[]> {
  return prisma.user.findMany({
    where: { projectMemberships: { some: scopeWhere as any } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** Case-insensitive title/description search — the only free-text fields Project has (no code/reference or customer field exists on the model). */
export function buildProjectSearchCondition(search: string): Record<string, unknown> {
  return {
    OR: [
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ],
  };
}

/**
 * Resolves to a `where` condition matching exactly the projects in
 * `baseWhere` whose (departmentId, status) resolves to `wantTerminal` —
 * "Active" (wantTerminal=false) or "Completed" (wantTerminal=true) per the
 * All Projects list's `?statusGroup=` filter, identical semantics to the
 * Projects Dashboard's Active/Completed KPI cards.
 */
export async function resolveProjectStatusGroupWhere(
  baseWhere: Record<string, unknown>,
  wantTerminal: boolean
): Promise<Record<string, unknown>> {
  const groups = await prisma.project.groupBy({
    by: ["departmentId", "status"],
    where: baseWhere as any,
    _count: { _all: true },
  });
  if (groups.length === 0) return NO_MATCH;

  const deptIds = Array.from(new Set(groups.map((g) => g.departmentId).filter((id): id is string => !!id)));
  const configMap = await getProjectTerminalConfigsForDepartments(deptIds);
  const matching = groups.filter((g) => resolveProjectTerminal(configMap, g.departmentId, g.status) === wantTerminal);
  if (matching.length === 0) return NO_MATCH;

  return { OR: matching.map((g) => ({ departmentId: g.departmentId, status: g.status })) };
}

/**
 * "Overdue" for the All Projects list's `?overdue=true` filter — the exact
 * same rule as the Projects Dashboard's Overdue Projects card: a due date
 * (Project.endDate) strictly before today (UTC), AND not terminal. Combines
 * the SQL-pushable date prefilter with resolveProjectStatusGroupWhere's
 * per-department terminal resolution over that same prefiltered set.
 */
export async function resolveProjectOverdueWhere(
  baseWhere: Record<string, unknown>,
  now: Date = new Date()
): Promise<Record<string, unknown>> {
  const overdueEligibleWhere = { ...baseWhere, endDate: { not: null, lt: startOfTodayUtc(now) } };
  const nonTerminalCondition = await resolveProjectStatusGroupWhere(overdueEligibleWhere, false);
  return { AND: [{ endDate: { not: null, lt: startOfTodayUtc(now) } }, nonTerminalCondition] };
}

export type ProjectActivityFilterKind = "has" | "completed" | "incomplete" | "overdue";

/**
 * Activity-based project filters (`?hasActivities=true`, `?activityStatus=
 * completed|incomplete`, `?activityOverdue=true`) — "projects that have at
 * least one activity matching X". "completed"/"incomplete" use the same
 * terminal-status resolution as the dashboard's Completed/Overdue Activities
 * counts (ActivityStatusConfig.isTerminal — NOT the separate isCompleted/
 * completedAt boolean fields, which the dashboard doesn't use either, so
 * this stays consistent with it). Scoped to activities belonging to projects
 * already matching every other active filter (`projectWhereSoFar`), so
 * combining this with search/status/etc. filters further first.
 */
export async function resolveProjectActivityWhere(
  projectWhereSoFar: Record<string, unknown>,
  kind: ProjectActivityFilterKind,
  now: Date = new Date()
): Promise<Record<string, unknown>> {
  if (kind === "has") {
    return { activities: { some: {} } };
  }

  const overdueDatePrefilter = kind === "overdue" ? { dueDate: { not: null, lt: startOfTodayUtc(now) } } : {};
  const groups = await prisma.projectActivity.groupBy({
    by: ["departmentId", "status"],
    where: { project: projectWhereSoFar as any, ...overdueDatePrefilter },
    _count: { _all: true },
  });
  if (groups.length === 0) return NO_MATCH;

  const deptIds = Array.from(new Set(groups.map((g) => g.departmentId).filter((id): id is string => !!id)));
  const configMap = await getActivityTerminalConfigsForDepartments(deptIds);
  const wantTerminal = kind === "completed";
  const matching = groups.filter((g) => resolveActivityTerminal(configMap, g.departmentId, g.status) === wantTerminal);
  if (matching.length === 0) return NO_MATCH;

  return {
    activities: {
      some: { OR: matching.map((g) => ({ departmentId: g.departmentId, status: g.status, ...overdueDatePrefilter })) },
    },
  };
}

// ─── Shared All-Projects-list query builder ──────────────────────────────────
// The SINGLE place the exact filter/sort semantics of app/(main)/projects/page.tsx
// live — reused VERBATIM (never re-implemented) by the Excel export route
// (app/api/projects/export/route.ts), so an export can never show a
// different result set than what the same filters show on-screen. The page
// itself calls this too (see its own refactor) instead of inlining the
// logic a second time.

/** Whitelisted against the List view's clickable column headers (Name, Department, Status, Priority, Date range, Created) — see lib/list-sort.ts's own doc comment for why this is never a dynamic `{ [sortBy]: order }` object. Exported so both the page and the export route resolve `?sortBy=` identically. */
export const PROJECT_SORT_KEYS: Record<string, SortKeyDef> = {
  title: (order) => ({ title: order }),
  // Prisma does not accept a `nulls` modifier on a nested RELATION field's
  // orderBy (only on a scalar column of the model being directly queried).
  // department is a nullable relation, so this relies on Postgres's own
  // deterministic default null ordering instead.
  department: (order) => ({ department: { name: order } }),
  status: (order) => ({ status: order }),
  priority: (order) => ({ priority: order }),
  startDate: (order) => ({ startDate: { sort: order, nulls: "last" } }),
  // Never null, so no `nulls` modifier needed — same as title/status/priority.
  createdAt: (order) => ({ createdAt: order }),
};
export const PROJECT_DEFAULT_ORDER_BY = [{ createdAt: "desc" as const }, { id: "asc" as const }];

const PROJECT_STATUS_VALUES = new Set<string>(Object.values(ProjectStatus));

/** Strict — rejects anything but exactly YYYY-MM-DD (the native `<input type="date">` format); never silently truncates garbage like a lenient `new Date()` call would. */
function parseStrictDate(raw: string | undefined): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Strict — rejects non-digit-only strings (e.g. "2abc"), never a lenient parseInt() truncation. */
function parseStrictIntIn(raw: string | undefined, allowed: readonly number[]): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return allowed.includes(n) ? n : undefined;
}

/** Every filter query param the All Projects list (and its Excel export) accept — exactly the page's own SearchParams interface, minus the pagination/view-only fields neither a `where` nor a `sort` cares about. */
export interface ProjectListFilterParams {
  sortBy?: string;
  sortOrder?: string;
  search?: string;
  status?: string;
  statusGroup?: string;
  overdue?: string;
  priority?: string;
  origin?: string;
  ownerId?: string;
  memberId?: string;
  subDepartmentId?: string;
  startDateAfter?: string;
  startDateBefore?: string;
  dueDateAfter?: string;
  dueDateBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  hasActivities?: string;
  activityStatus?: string;
  activityOverdue?: string;
}

export type ProjectListQueryResult =
  | { denied: true }
  | {
      denied: false;
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>[];
      /** The raw department-authorization scope (BEFORE any flat/terminal filter is layered on) — exposed so a caller needing it independently (e.g. the page's own Owner/Member filter-dropdown options, which are deliberately scoped by department only, never by the OTHER active filters — see getProjectOwnerOptions' doc comment) never has to re-call buildProjectListWhere a second time. */
      scope: Record<string, unknown>;
    };

/**
 * Builds the exact `where`/`orderBy` the All Projects list uses — scope
 * (department-authorization, via buildProjectListWhere) + every flat filter
 * + the terminal-status-dependent ones, in the SAME order/combination
 * app/(main)/projects/page.tsx already applied inline before this was
 * extracted. `effectiveDepartmentId` is resolved by the CALLER (the page
 * picks it from `?departmentId=` or the caller's active workspace; the
 * export route does the identical one-liner against its own request) —
 * kept as a parameter here rather than re-resolved internally, since "which
 * workspace a request is scoped to" is a caller concern (e.g. the page's
 * own "choose a workspace" gate has no equivalent in a headless API route),
 * while "how a department + filters become a Prisma where" is the one true
 * shared concern this function exists for.
 */
export async function buildProjectListQuery(
  userId: string,
  role: Role,
  effectiveDepartmentId: string | null | undefined,
  params: ProjectListFilterParams
): Promise<ProjectListQueryResult> {
  const scope = await buildProjectListWhere(userId, role, effectiveDepartmentId);
  if ("denied" in scope) return { denied: true };

  const andConditions: Record<string, unknown>[] = [scope as Record<string, unknown>];

  if (params.subDepartmentId) andConditions.push({ subDepartmentId: params.subDepartmentId });
  if (params.search) andConditions.push(buildProjectSearchCondition(params.search));

  const exactStatus = params.status && PROJECT_STATUS_VALUES.has(params.status) ? (params.status as ProjectStatus) : undefined;
  if (exactStatus) andConditions.push({ status: exactStatus });

  const priority = parseStrictIntIn(params.priority, [1, 2, 3]);
  if (priority !== undefined) andConditions.push({ priority });

  if (params.ownerId) andConditions.push({ ownerId: params.ownerId });
  if (params.memberId) andConditions.push({ members: { some: { id: params.memberId } } });

  // Origin — canonical source of truth is Project.projectRequestId, never
  // inferred from title/members/owner count/anything else.
  const origin = params.origin === "request" || params.origin === "manual" ? params.origin : undefined;
  if (origin === "request") andConditions.push({ projectRequestId: { not: null } });
  else if (origin === "manual") andConditions.push({ projectRequestId: null });

  const startDateAfter = parseStrictDate(params.startDateAfter);
  const startDateBefore = parseStrictDate(params.startDateBefore);
  if (startDateAfter || startDateBefore) {
    andConditions.push({ startDate: { ...(startDateAfter ? { gte: startDateAfter } : {}), ...(startDateBefore ? { lte: startDateBefore } : {}) } });
  }
  const dueDateAfter = parseStrictDate(params.dueDateAfter);
  const dueDateBefore = parseStrictDate(params.dueDateBefore);
  if (dueDateAfter || dueDateBefore) {
    andConditions.push({ endDate: { ...(dueDateAfter ? { gte: dueDateAfter } : {}), ...(dueDateBefore ? { lte: dueDateBefore } : {}) } });
  }
  const createdAfter = parseStrictDate(params.createdAfter);
  const createdBefore = parseStrictDate(params.createdBefore);
  if (createdAfter || createdBefore) {
    andConditions.push({ createdAt: { ...(createdAfter ? { gte: createdAfter } : {}), ...(createdBefore ? { lte: createdBefore } : {}) } });
  }

  // A snapshot (spread copy), not a live reference — see the identical
  // rationale this had inline on the page before extraction: a LATER
  // terminal-dependent push here must never retroactively change what an
  // EARLIER resolve* call in this same block already saw.
  const flatWhere = { AND: [...andConditions] };

  if (params.overdue === "true") {
    andConditions.push(await resolveProjectOverdueWhere(flatWhere));
  }
  const statusGroup = params.statusGroup === "active" || params.statusGroup === "completed" ? params.statusGroup : undefined;
  if (statusGroup) {
    andConditions.push(await resolveProjectStatusGroupWhere(flatWhere, statusGroup === "completed"));
  }
  if (params.hasActivities === "true") {
    andConditions.push(await resolveProjectActivityWhere(flatWhere, "has"));
  }
  const activityStatus = params.activityStatus === "completed" || params.activityStatus === "incomplete" ? params.activityStatus : undefined;
  if (activityStatus) {
    andConditions.push(await resolveProjectActivityWhere(flatWhere, activityStatus));
  }
  if (params.activityOverdue === "true") {
    andConditions.push(await resolveProjectActivityWhere(flatWhere, "overdue"));
  }

  const sort = resolveListSort(PROJECT_SORT_KEYS, PROJECT_DEFAULT_ORDER_BY, params.sortBy, params.sortOrder);

  return { denied: false, where: { AND: andConditions }, orderBy: sort.orderBy, scope: scope as Record<string, unknown> };
}
