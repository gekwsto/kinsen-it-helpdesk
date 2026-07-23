import { prisma } from "@/lib/prisma";
import { ActivityStatus } from "@prisma/client";

/**
 * Fallback percentages used when a department is missing a row for some
 * status (should only happen for a department created before this feature,
 * or if a row was somehow deleted directly in the DB — seed.ts ensures every
 * department has all 6 rows, see lib/services/config-starter-data.ts) and
 * as the starter values every department is seeded with (editable per
 * department afterwards via /admin/activity-progress).
 */
export const DEFAULT_STATUS_PROGRESS: Record<ActivityStatus, number> = {
  TODO: 0,
  IN_PROGRESS: 50,
  ON_HOLD: 50,
  BLOCKED: 50,
  COMPLETED: 100,
  CANCELLED: 0,
};

/** One department's full 6-status map, merged over the defaults so a missing row never crashes anything. */
export async function getDepartmentProgressConfig(departmentId: string): Promise<Record<ActivityStatus, number>> {
  const rows = await prisma.activityProgressConfig.findMany({ where: { departmentId } });
  const map: Record<ActivityStatus, number> = { ...DEFAULT_STATUS_PROGRESS };
  for (const row of rows) map[row.status] = row.progressPercent;
  return map;
}

/** Single-activity convenience wrapper — null departmentId (should be rare/legacy) falls back to the hardcoded defaults. */
export async function getActivityProgressFromStatus(departmentId: string | null, status: ActivityStatus): Promise<number> {
  if (!departmentId) return DEFAULT_STATUS_PROGRESS[status];
  const config = await getDepartmentProgressConfig(departmentId);
  return config[status] ?? DEFAULT_STATUS_PROGRESS[status];
}

/** Bulk-loader for list/Gantt pages with many activities across a handful of departments — one query total, not one per activity. */
export async function getProgressConfigsForDepartments(departmentIds: string[]): Promise<Record<string, Record<ActivityStatus, number>>> {
  const uniqueIds = Array.from(new Set(departmentIds));
  const rows = uniqueIds.length > 0
    ? await prisma.activityProgressConfig.findMany({ where: { departmentId: { in: uniqueIds } } })
    : [];
  const result: Record<string, Record<ActivityStatus, number>> = {};
  for (const id of uniqueIds) result[id] = { ...DEFAULT_STATUS_PROGRESS };
  for (const row of rows) result[row.departmentId][row.status] = row.progressPercent;
  return result;
}

/** Sync resolver paired with getProgressConfigsForDepartments — safe even if departmentId wasn't in the bulk-loaded set. */
export function resolveProgress(
  configMap: Record<string, Record<ActivityStatus, number>>,
  departmentId: string | null,
  status: ActivityStatus
): number {
  if (!departmentId || !configMap[departmentId]) return DEFAULT_STATUS_PROGRESS[status];
  return configMap[departmentId][status] ?? DEFAULT_STATUS_PROGRESS[status];
}
