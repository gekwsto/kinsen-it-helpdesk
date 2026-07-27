import { prisma } from "@/lib/prisma";
import { ProjectStatus, ActivityStatus } from "@prisma/client";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";

/**
 * Fail-safe value used ONLY when a (departmentId, status) row is genuinely
 * missing from ProjectStatusConfig/ActivityStatusConfig — despite the
 * migration backfill and createDepartment() seeding that are supposed to
 * guarantee a full row set always exists (prisma/migrations/
 * 20260729000000_add_priority_config_and_backfill), AND after the
 * departmentId:null -> legacy department fallback below has already been
 * tried. A real gap means: a status added to the Prisma enum after backfill
 * without a matching migration, a department created through a path that
 * bypassed createDepartment(), manually deleted rows, or no legacy
 * department configured at all (DEFAULT_DEPARTMENT_SLUG unset/unseeded).
 *
 * This is NOT derived from the status's name or enum value — every gap,
 * for every status, resolves to this SAME fixed constant, and the gap is
 * loudly logged (reportConfigGap) so it gets fixed rather than silently
 * repeating forever. `true` (terminal) is chosen as the fail-safe direction
 * so an unresolvable status never produces a false "Overdue" alarm on a
 * user-facing badge — the safer of the two possible wrong answers.
 */
const FAILSAFE_TERMINAL_ON_MISSING_CONFIG = true;

// De-duplicates repeated log lines for the exact same gap within a process
// lifetime — a dashboard query can hit the same missing row dozens of times
// per request; the operator needs to see it once, clearly, not a flood.
const reportedGaps = new Set<string>();

function reportConfigGap(kind: "project" | "activity", departmentId: string | null, status: string) {
  const key = `${kind}:${departmentId ?? "null"}:${status}`;
  if (reportedGaps.has(key)) return;
  reportedGaps.add(key);
  const table = kind === "project" ? "ProjectStatusConfig" : "ActivityStatusConfig";
  console.error(
    `[status-terminal] configuration gap: no ${table} row for departmentId=${departmentId ?? "null"} status=${status} (and no usable legacy-department fallback). ` +
    `Resolving isTerminal=${FAILSAFE_TERMINAL_ON_MISSING_CONFIG} as a fail-safe (fixed for every status — NOT derived from this status's name). ` +
    `This should not occur after the full backfill migration; verify this department was created via createDepartment().`
  );
}

// Sentinel map key a departmentId:null row's config is resolved under —
// aliased to the app's configured legacy department (DEFAULT_DEPARTMENT_SLUG,
// see lib/services/department-service.ts), the SAME fallback every other
// department-scoped query in this app already applies to a legacy row
// (buildEntityListWhere folds departmentId:null into the legacy department
// when it's the department being viewed; getResourcePlanningEvents does the
// same). Never a literal string a real department id could collide with in
// practice (cuids), but namespaced explicitly regardless.
const LEGACY_NULL_KEY = "__legacy_null_department__";

type ProjectTerminalMap = Record<string, Partial<Record<ProjectStatus, boolean>>>;
type ActivityTerminalMap = Record<string, Partial<Record<ActivityStatus, boolean>>>;

/**
 * Bulk loader — same shape/precedent as getProgressConfigsForDepartments
 * (lib/activities/activity-progress.ts): one query for N departments, never
 * N+1 per row. Unlike that function, this one does NOT pre-fill missing
 * entries with a default map — an absent (department, status) key is a
 * real signal (checked by resolveProjectTerminal below), not silently
 * papered over here. Also resolves the legacy department's own rows under
 * LEGACY_NULL_KEY once, so a departmentId:null row (a legacy activity/
 * project predating department scoping) resolves against a REAL
 * department's configuration instead of immediately failing safe.
 */
export async function getProjectTerminalConfigsForDepartments(departmentIds: string[]): Promise<ProjectTerminalMap> {
  const legacyId = await getDefaultLegacyDepartmentId();
  const uniqueIds = Array.from(new Set([...departmentIds, ...(legacyId ? [legacyId] : [])]));
  const rows = uniqueIds.length > 0
    ? await prisma.projectStatusConfig.findMany({ where: { departmentId: { in: uniqueIds } } })
    : [];
  const result: ProjectTerminalMap = {};
  for (const id of uniqueIds) result[id] = {};
  for (const row of rows) result[row.departmentId][row.status] = row.isTerminal;
  if (legacyId) result[LEGACY_NULL_KEY] = result[legacyId];
  return result;
}

export async function getActivityTerminalConfigsForDepartments(departmentIds: string[]): Promise<ActivityTerminalMap> {
  const legacyId = await getDefaultLegacyDepartmentId();
  const uniqueIds = Array.from(new Set([...departmentIds, ...(legacyId ? [legacyId] : [])]));
  const rows = uniqueIds.length > 0
    ? await prisma.activityStatusConfig.findMany({ where: { departmentId: { in: uniqueIds } } })
    : [];
  const result: ActivityTerminalMap = {};
  for (const id of uniqueIds) result[id] = {};
  for (const row of rows) result[row.departmentId][row.status] = row.isTerminal;
  if (legacyId) result[LEGACY_NULL_KEY] = result[legacyId];
  return result;
}

export function resolveProjectTerminal(configMap: ProjectTerminalMap, departmentId: string | null, status: ProjectStatus): boolean {
  const value = departmentId ? configMap[departmentId]?.[status] : configMap[LEGACY_NULL_KEY]?.[status];
  if (value === undefined) {
    reportConfigGap("project", departmentId, status);
    return FAILSAFE_TERMINAL_ON_MISSING_CONFIG;
  }
  return value;
}

export function resolveActivityTerminal(configMap: ActivityTerminalMap, departmentId: string | null, status: ActivityStatus): boolean {
  const value = departmentId ? configMap[departmentId]?.[status] : configMap[LEGACY_NULL_KEY]?.[status];
  if (value === undefined) {
    reportConfigGap("activity", departmentId, status);
    return FAILSAFE_TERMINAL_ON_MISSING_CONFIG;
  }
  return value;
}

/** Single-department convenience wrapper for call sites with exactly one department in scope (a detail page, a single PATCH) — reads the real row directly rather than paying for the bulk-loader/resolve pair. Same fail-safe/gap-logging behavior as the bulk path, including the departmentId:null -> legacy department fallback. */
export async function isProjectStatusTerminal(departmentId: string | null, status: ProjectStatus): Promise<boolean> {
  const effectiveDepartmentId = departmentId ?? (await getDefaultLegacyDepartmentId());
  if (!effectiveDepartmentId) {
    reportConfigGap("project", departmentId, status);
    return FAILSAFE_TERMINAL_ON_MISSING_CONFIG;
  }
  const row = await prisma.projectStatusConfig.findUnique({ where: { departmentId_status: { departmentId: effectiveDepartmentId, status } } });
  if (!row) {
    reportConfigGap("project", departmentId, status);
    return FAILSAFE_TERMINAL_ON_MISSING_CONFIG;
  }
  return row.isTerminal;
}

export async function isActivityStatusTerminal(departmentId: string | null, status: ActivityStatus): Promise<boolean> {
  const effectiveDepartmentId = departmentId ?? (await getDefaultLegacyDepartmentId());
  if (!effectiveDepartmentId) {
    reportConfigGap("activity", departmentId, status);
    return FAILSAFE_TERMINAL_ON_MISSING_CONFIG;
  }
  const row = await prisma.activityStatusConfig.findUnique({ where: { departmentId_status: { departmentId: effectiveDepartmentId, status } } });
  if (!row) {
    reportConfigGap("activity", departmentId, status);
    return FAILSAFE_TERMINAL_ON_MISSING_CONFIG;
  }
  return row.isTerminal;
}

/** Test-only: clears the gap-log dedupe set so a test suite can assert a gap was (re-)logged after intentionally deleting rows. Never called from application code. */
export function __resetReportedGapsForTests(): void {
  reportedGaps.clear();
}
