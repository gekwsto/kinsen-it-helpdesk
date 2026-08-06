/**
 * Shared Prisma `where`-condition builders for ProjectActivity's
 * terminal-status concept — the activity-side mirror of
 * lib/services/project-query-service.ts, used by BOTH the Projects
 * Dashboard's Completed/Overdue Activities KPI counts
 * (lib/services/projects-dashboard-service.ts) and the All Activities
 * list's URL-driven filters (app/(main)/activities/page.tsx), so a
 * dashboard card's number and what its link actually shows can never
 * silently disagree. Calls the exact same low-level primitives the
 * dashboard already uses (resolveActivityTerminal from
 * lib/status-terminal.ts, startOfTodayUtc from lib/overdue.ts) — never a
 * re-derived or approximated copy of that logic.
 *
 * Terminal-ness is per (departmentId, status) — see ActivityStatusConfig in
 * prisma/schema.prisma — so it cannot be expressed as a single static
 * Prisma `where` clause. A bounded `groupBy` discovers exactly which
 * (departmentId, status) combinations exist among rows already matching
 * every OTHER active filter, each combination's terminal-ness is resolved
 * via the same bulk-loaded config map the dashboard uses, and only the
 * matching combinations are turned into an explicit `OR` list — bounded by
 * "distinct departments × distinct status values actually present" (at
 * most 6 ActivityStatus values per department), never by row count. No
 * activity rows are ever loaded into memory to be filtered client-side.
 */
import { prisma } from "@/lib/prisma";
import { getActivityTerminalConfigsForDepartments, resolveActivityTerminal } from "@/lib/status-terminal";
import { startOfTodayUtc } from "@/lib/overdue";

const NO_MATCH: Record<string, unknown> = { id: { in: [] as string[] } };

/** Case-insensitive title/description search. */
export function buildActivitySearchCondition(search: string): Record<string, unknown> {
  return {
    OR: [
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ],
  };
}

/**
 * Resolves to a `where` condition matching exactly the activities in
 * `baseWhere` whose (departmentId, status) resolves to `wantTerminal` —
 * "incomplete" (wantTerminal=false) or "completed" (wantTerminal=true) per
 * the All Activities list's `?statusGroup=` filter, identical semantics to
 * the Projects Dashboard's Completed Activities KPI card.
 */
export async function resolveActivityStatusGroupWhere(
  baseWhere: Record<string, unknown>,
  wantTerminal: boolean
): Promise<Record<string, unknown>> {
  const groups = await prisma.projectActivity.groupBy({
    by: ["departmentId", "status"],
    where: baseWhere as any,
    _count: { _all: true },
  });
  if (groups.length === 0) return NO_MATCH;

  const deptIds = Array.from(new Set(groups.map((g) => g.departmentId).filter((id): id is string => !!id)));
  const configMap = await getActivityTerminalConfigsForDepartments(deptIds);
  const matching = groups.filter((g) => resolveActivityTerminal(configMap, g.departmentId, g.status) === wantTerminal);
  if (matching.length === 0) return NO_MATCH;

  return { OR: matching.map((g) => ({ departmentId: g.departmentId, status: g.status })) };
}

/**
 * "Overdue" for the All Activities list's `?overdue=true` filter — the
 * exact same rule as the Projects Dashboard's Overdue Activities card: a
 * due date strictly before today (UTC), AND not terminal. Combines the
 * SQL-pushable date prefilter with resolveActivityStatusGroupWhere's
 * per-department terminal resolution over that same prefiltered set.
 */
export async function resolveActivityOverdueWhere(
  baseWhere: Record<string, unknown>,
  now: Date = new Date()
): Promise<Record<string, unknown>> {
  const overdueEligibleWhere = { ...baseWhere, dueDate: { not: null, lt: startOfTodayUtc(now) } };
  const nonTerminalCondition = await resolveActivityStatusGroupWhere(overdueEligibleWhere, false);
  return { AND: [{ dueDate: { not: null, lt: startOfTodayUtc(now) } }, nonTerminalCondition] };
}
