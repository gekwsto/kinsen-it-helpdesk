import { prisma } from "@/lib/prisma";
import { ActivityStatus } from "@prisma/client";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import { ACTIVITY_STATUS_KEYS } from "@/components/gantt/status-colors";

/**
 * Department-scoped display metadata (label/color/sortOrder/isEnabled) for
 * ActivityStatus — reads the SAME ActivityStatusConfig table
 * lib/status-terminal.ts already uses for isTerminal (never a second/
 * parallel config system). The fixed ActivityStatus enum key never changes
 * (TODO stays TODO) — only what a department calls it, what color it shows,
 * and where it sorts are department-specific.
 *
 * A missing row is a real configuration gap — never guessed from the
 * status's name. Unlike Activity Progress (a business-critical percentage,
 * where a gap rejects the write outright), display metadata for a READ path
 * rendering a list of many activities must not crash the whole page for one
 * misconfigured row, so a gap here resolves to a fixed, deterministic,
 * clearly-a-gap fallback (the raw enum key AS the label, e.g. "TODO" not
 * "To Do" — visibly different from a real configured label, never a
 * friendly-looking guess) and is loudly logged, exactly like every other
 * no-fallback resolver in this app.
 */
const FAILSAFE_COLOR = "#94a3b8";

const reportedGaps = new Set<string>();
function reportConfigGap(departmentId: string | null, status: string) {
  const key = `${departmentId ?? "null"}:${status}`;
  if (reportedGaps.has(key)) return;
  reportedGaps.add(key);
  console.error(
    `[activity-status-config] configuration gap: no ActivityStatusConfig row for departmentId=${departmentId ?? "null"} status=${status} (and no usable legacy-department fallback). ` +
    `Resolving label=${status} (the raw enum key, NOT a friendly guess) as a fail-safe. ` +
    `This should not occur after the full backfill migration; verify this department was created via createDepartment().`
  );
}

const LEGACY_NULL_KEY = "__legacy_null_department__";

export interface ActivityStatusDisplayRow {
  status: ActivityStatus;
  label: string;
  color: string;
  sortOrder: number;
  isEnabled: boolean;
  isTerminal: boolean;
}

type DisplayMap = Record<string, Partial<Record<ActivityStatus, ActivityStatusDisplayRow>>>;

/** Bulk loader — one query for N departments, matching the established getProgressConfigsForDepartments/getActivityTerminalConfigsForDepartments precedent. Also resolves the legacy department's own rows under LEGACY_NULL_KEY for departmentId:null activities. */
export async function getActivityStatusDisplayConfigsForDepartments(departmentIds: string[]): Promise<DisplayMap> {
  const legacyId = await getDefaultLegacyDepartmentId();
  const uniqueIds = Array.from(new Set([...departmentIds, ...(legacyId ? [legacyId] : [])]));
  const rows = uniqueIds.length > 0
    ? await prisma.activityStatusConfig.findMany({ where: { departmentId: { in: uniqueIds } } })
    : [];
  const result: DisplayMap = {};
  for (const id of uniqueIds) result[id] = {};
  for (const row of rows) {
    result[row.departmentId][row.status] = { status: row.status, label: row.label, color: row.color, sortOrder: row.sortOrder, isEnabled: row.isEnabled, isTerminal: row.isTerminal };
  }
  if (legacyId) result[LEGACY_NULL_KEY] = result[legacyId];
  return result;
}

/**
 * Resolves ONE status's display metadata for the given department — never
 * throws (read/display path), always returns a usable row. `isEnabled`
 * reflects the REAL stored value even when `false`: a disabled status must
 * still render its historical label/color for existing activities (only
 * "available for a NEW activity" dropdowns should filter on isEnabled —
 * see getEnabledActivityStatusesForDepartment below).
 */
export function resolveActivityStatusDisplay(configMap: DisplayMap, departmentId: string | null, status: ActivityStatus): ActivityStatusDisplayRow {
  const row = departmentId ? configMap[departmentId]?.[status] : configMap[LEGACY_NULL_KEY]?.[status];
  if (!row) {
    reportConfigGap(departmentId, status);
    const fallbackSortOrder = ACTIVITY_STATUS_KEYS.indexOf(status);
    return { status, label: status, color: FAILSAFE_COLOR, sortOrder: fallbackSortOrder >= 0 ? fallbackSortOrder : 99, isEnabled: true, isTerminal: true };
  }
  return row;
}

/** Single-department convenience wrapper — reads the real row directly. Same gap-logging/legacy-fallback behavior as the bulk path. */
export async function getActivityStatusDisplay(departmentId: string | null, status: ActivityStatus): Promise<ActivityStatusDisplayRow> {
  const effectiveDepartmentId = departmentId ?? (await getDefaultLegacyDepartmentId());
  if (!effectiveDepartmentId) {
    reportConfigGap(departmentId, status);
    const fallbackSortOrder = ACTIVITY_STATUS_KEYS.indexOf(status);
    return { status, label: status, color: FAILSAFE_COLOR, sortOrder: fallbackSortOrder >= 0 ? fallbackSortOrder : 99, isEnabled: true, isTerminal: true };
  }
  const row = await prisma.activityStatusConfig.findUnique({ where: { departmentId_status: { departmentId: effectiveDepartmentId, status } } });
  if (!row) {
    reportConfigGap(departmentId, status);
    const fallbackSortOrder = ACTIVITY_STATUS_KEYS.indexOf(status);
    return { status, label: status, color: FAILSAFE_COLOR, sortOrder: fallbackSortOrder >= 0 ? fallbackSortOrder : 99, isEnabled: true, isTerminal: true };
  }
  return { status: row.status, label: row.label, color: row.color, sortOrder: row.sortOrder, isEnabled: row.isEnabled, isTerminal: row.isTerminal };
}

/** One department's real rows (only what actually exists), sorted by the department's own configured order — the admin UI's source of truth. */
export async function getDepartmentActivityStatusRows(departmentId: string): Promise<ActivityStatusDisplayRow[]> {
  const rows = await prisma.activityStatusConfig.findMany({ where: { departmentId }, orderBy: { sortOrder: "asc" } });
  return rows.map((r) => ({ status: r.status, label: r.label, color: r.color, sortOrder: r.sortOrder, isEnabled: r.isEnabled, isTerminal: r.isTerminal }));
}

/** Only ENABLED rows, sorted — what a "New Activity" status dropdown must offer (a disabled status is never selectable for new activities, even though existing ones keep displaying it normally via resolveActivityStatusDisplay above). */
export async function getEnabledActivityStatusesForDepartment(departmentId: string): Promise<ActivityStatusDisplayRow[]> {
  const rows = await prisma.activityStatusConfig.findMany({ where: { departmentId, isEnabled: true }, orderBy: { sortOrder: "asc" } });
  return rows.map((r) => ({ status: r.status, label: r.label, color: r.color, sortOrder: r.sortOrder, isEnabled: r.isEnabled, isTerminal: r.isTerminal }));
}

/** Test-only: clears the gap-log dedupe set. Never called from application code. */
export function __resetReportedGapsForTests(): void {
  reportedGaps.clear();
}
