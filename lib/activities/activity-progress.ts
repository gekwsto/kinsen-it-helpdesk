import { prisma } from "@/lib/prisma";
import { ActivityStatus } from "@prisma/client";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";

/**
 * There is NO numeric fallback for a missing/disabled progress
 * configuration — a gap is a real configuration error, not a business value
 * to guess at. Every consumer of this module either:
 *  - is a WRITE path (activity create/status change) and MUST catch
 *    ActivityProgressConfigurationError and reject the request
 *    (`configuration_required`), never persist a fabricated percentage; or
 *  - is a READ path and gets a `ProgressResolution` discriminated union
 *    (`ok: false` on a gap) that the UI renders as an explicit
 *    "Configuration required" state, never as "0%".
 *
 * In healthy, normal operation this should never actually trigger: every
 * department gets a full row set from ensureActivityProgressConfigForDepartment
 * (lib/services/config-starter-data.ts, called by both prisma/seed.ts and
 * createDepartment() in the same transaction as department creation), and
 * /api/admin/activity-progress's DELETE/PUT now block disabling or deleting
 * a row that any existing activity in the department is currently using
 * (see the usage-analysis guard in that route) — so no ordinary admin
 * action can leave a status that real activities depend on without a valid
 * config row. A gap here means either a genuine dev/ops issue (a new
 * ActivityStatus enum value shipped without a migration backfill, or a
 * department created through a path that bypassed the ensure-function) or
 * direct DB tampering — always worth fixing, never worth guessing around.
 */
export class ActivityProgressConfigurationError extends Error {
  constructor(
    public readonly departmentId: string | null,
    public readonly status: ActivityStatus,
    public readonly reason: "missing" | "disabled"
  ) {
    super(
      `No usable ActivityProgressConfig for departmentId=${departmentId ?? "null"} status=${status} (${reason}). ` +
      `This department has no configured business progress percentage for this status.`
    );
    this.name = "ActivityProgressConfigurationError";
  }
}

const reportedGaps = new Set<string>();
function reportConfigGap(departmentId: string | null, status: string, reason: "missing" | "disabled") {
  const key = `${departmentId ?? "null"}:${status}:${reason}`;
  if (reportedGaps.has(key)) return;
  reportedGaps.add(key);
  console.error(
    `[activity-progress] configuration gap: ${reason === "missing" ? "no" : "a DISABLED"} ActivityProgressConfig row for departmentId=${departmentId ?? "null"} status=${status} (and no usable legacy-department fallback). ` +
    `No numeric value is substituted — write paths reject the request, read paths render an explicit "Configuration required" state. ` +
    `This should not occur after the full backfill migration and the usage-analysis delete/disable guard; verify this department was created via createDepartment().`
  );
}

// Sentinel map key a departmentId:null row's config is resolved under —
// aliased to the app's configured legacy department (DEFAULT_DEPARTMENT_SLUG),
// the SAME fallback every other department-scoped resolver in this app
// already applies to a legacy row (lib/status-terminal.ts,
// buildEntityListWhere, getResourcePlanningEvents). This is a department
// *identity* fallback (which real department a legacy row belongs to), not
// a numeric progress fallback — the percentage itself always comes from a
// real row.
const LEGACY_NULL_KEY = "__legacy_null_department__";

export interface ProgressConfigRow {
  progressPercent: number;
  isEnabled: boolean;
  sortOrder: number;
}

type ProgressConfigMap = Record<string, Partial<Record<ActivityStatus, ProgressConfigRow>>>;

/**
 * Bulk loader for list/Gantt/Dashboard pages with many activities across a
 * handful of departments — one query total, not one per activity. Does NOT
 * pre-fill missing entries with a default map — an absent or disabled
 * (department, status) row is a real signal (checked by resolveProgress
 * below), never silently papered over here. Also resolves the legacy
 * department's own rows under LEGACY_NULL_KEY once, so a departmentId:null
 * activity (predating department scoping) resolves against a REAL
 * department's configuration instead of immediately failing.
 */
export async function getProgressConfigsForDepartments(departmentIds: string[]): Promise<ProgressConfigMap> {
  const legacyId = await getDefaultLegacyDepartmentId();
  const uniqueIds = Array.from(new Set([...departmentIds, ...(legacyId ? [legacyId] : [])]));
  const rows = uniqueIds.length > 0
    ? await prisma.activityProgressConfig.findMany({ where: { departmentId: { in: uniqueIds } } })
    : [];
  const result: ProgressConfigMap = {};
  for (const id of uniqueIds) result[id] = {};
  for (const row of rows) {
    result[row.departmentId][row.status] = { progressPercent: row.progressPercent, isEnabled: row.isEnabled, sortOrder: row.sortOrder };
  }
  if (legacyId) result[LEGACY_NULL_KEY] = result[legacyId];
  return result;
}

/**
 * Discriminated result for READ/display paths — `ok: false` MUST be
 * rendered by the UI as an explicit "Configuration required" state, never
 * silently coerced to a number (0 or otherwise). See callers in
 * app/(main)/activities/page.tsx, my-activities/page.tsx, both Gantt pages,
 * and the components consuming their mapped `progress` field
 * (activity-list.tsx, activity-card.tsx, gantt-chart.tsx).
 */
export type ProgressResolution =
  | { ok: true; percent: number }
  | { ok: false; departmentId: string | null; status: ActivityStatus; reason: "missing" | "disabled" };

/** Sync resolver paired with getProgressConfigsForDepartments — the single central resolution logic every consumer (Activity List/Grid/cards, Project progress, Dashboard, Gantt, Resource Planning) shares, never re-implemented locally. Never fabricates a percentage on a gap. */
export function resolveProgress(
  configMap: ProgressConfigMap,
  departmentId: string | null,
  status: ActivityStatus
): ProgressResolution {
  const row = departmentId ? configMap[departmentId]?.[status] : configMap[LEGACY_NULL_KEY]?.[status];
  if (!row) {
    reportConfigGap(departmentId, status, "missing");
    return { ok: false, departmentId, status, reason: "missing" };
  }
  if (!row.isEnabled) {
    reportConfigGap(departmentId, status, "disabled");
    return { ok: false, departmentId, status, reason: "disabled" };
  }
  return { ok: true, percent: row.progressPercent };
}

/** Display convenience for read paths that just need `number | null` (not the full discriminated result) to hand to a UI component — null MUST be rendered as an explicit "Configuration required" state (see components/shared/progress-display.tsx), never as 0. */
export function resolveProgressPercentOrNull(
  configMap: ProgressConfigMap,
  departmentId: string | null,
  status: ActivityStatus
): number | null {
  const resolution = resolveProgress(configMap, departmentId, status);
  return resolution.ok ? resolution.percent : null;
}

/**
 * WRITE-path resolver — throws ActivityProgressConfigurationError on a gap
 * instead of returning any number. Every caller (POST /api/activities,
 * PATCH /api/activities/[id]) MUST catch this and reject the request with a
 * clear `configuration_required` error; none may catch-and-substitute a
 * fallback value. Single-activity convenience wrapper for call sites with
 * exactly one department in scope — reads the real row directly rather than
 * paying for the bulk-loader/resolve pair. Same gap-logging and
 * departmentId:null -> legacy department fallback as the bulk path.
 */
export async function getActivityProgressFromStatus(departmentId: string | null, status: ActivityStatus): Promise<number> {
  const effectiveDepartmentId = departmentId ?? (await getDefaultLegacyDepartmentId());
  if (!effectiveDepartmentId) {
    reportConfigGap(departmentId, status, "missing");
    throw new ActivityProgressConfigurationError(departmentId, status, "missing");
  }
  const row = await prisma.activityProgressConfig.findUnique({
    where: { departmentId_status: { departmentId: effectiveDepartmentId, status } },
  });
  if (!row) {
    reportConfigGap(departmentId, status, "missing");
    throw new ActivityProgressConfigurationError(departmentId, status, "missing");
  }
  if (!row.isEnabled) {
    reportConfigGap(departmentId, status, "disabled");
    throw new ActivityProgressConfigurationError(departmentId, status, "disabled");
  }
  return row.progressPercent;
}

/**
 * Non-throwing sibling of getActivityProgressFromStatus, for READ paths
 * (e.g. GET /api/activities/[id]) that must still render the activity even
 * when its current config has a gap — the response carries an explicit
 * `ok: false` resolution instead of a fabricated percentage; the caller
 * decides how to surface that (e.g. `progress: null` +
 * `progressConfigError` in the JSON body, never `progress: 0`).
 */
export async function tryGetActivityProgressFromStatus(departmentId: string | null, status: ActivityStatus): Promise<ProgressResolution> {
  try {
    const percent = await getActivityProgressFromStatus(departmentId, status);
    return { ok: true, percent };
  } catch (err) {
    if (err instanceof ActivityProgressConfigurationError) {
      return { ok: false, departmentId, status, reason: err.reason };
    }
    throw err;
  }
}

export interface DepartmentProgressRow {
  status: ActivityStatus;
  progressPercent: number;
  isEnabled: boolean;
  sortOrder: number;
}

/** One department's real rows (only what actually exists — after a delete, fewer than 6), sorted by the department's own configured order. Used by the admin UI, which computes "missing statuses" (available to add back) as ACTIVITY_STATUS_KEYS minus the statuses present here. */
export async function getDepartmentProgressRows(departmentId: string): Promise<DepartmentProgressRow[]> {
  const rows = await prisma.activityProgressConfig.findMany({
    where: { departmentId },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((r) => ({ status: r.status, progressPercent: r.progressPercent, isEnabled: r.isEnabled, sortOrder: r.sortOrder }));
}

/**
 * How many of a department's activities (including departmentId:null
 * legacy activities that resolve to this department as the app's default
 * legacy department) currently have a given status — the usage-analysis
 * check consulted by /api/admin/activity-progress before allowing a
 * disable or delete, so an admin can never silently strand real activities
 * without progress semantics. Returns 0 for a status nothing currently uses,
 * meaning disable/delete is safe.
 */
export async function countActivitiesUsingStatus(departmentId: string, status: ActivityStatus): Promise<number> {
  const legacyId = await getDefaultLegacyDepartmentId();
  const matchesLegacyNull = legacyId === departmentId;
  return prisma.projectActivity.count({
    where: matchesLegacyNull
      ? { status, OR: [{ departmentId }, { departmentId: null }] }
      : { status, departmentId },
  });
}

/** Test-only: clears the gap-log dedupe set so a test suite can assert a gap was (re-)logged after intentionally deleting/disabling rows. Never called from application code. */
export function __resetReportedGapsForTests(): void {
  reportedGaps.clear();
}
