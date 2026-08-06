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

const NO_MATCH: Record<string, unknown> = { id: { in: [] as string[] } };

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
