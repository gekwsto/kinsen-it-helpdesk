import { prisma } from "@/lib/prisma";
import { ActivityPriority } from "@prisma/client";
import { ACTIVITY_PRIORITY_LABEL } from "@/lib/activity-priority";

/**
 * Department-scoped enablement + display order for ActivityPriority
 * (ActivityPriorityConfig) — the source of truth for "the department's
 * configured priority order", read by the Project Gantt Priority filter
 * and Resource Planning's priority filter (the two places that previously
 * each hardcoded their own copy of the canonical URGENT>HIGH>MEDIUM>LOW
 * order). Same fail-safe/gap-logging discipline as lib/status-terminal.ts —
 * a missing row after the full backfill migration is a real gap, not a
 * license to fall back to a hardcoded order.
 */
const FAILSAFE_SORT_ORDER_ON_MISSING_CONFIG = 999; // sorts last — never silently jumps ahead of configured values
const FAILSAFE_ENABLED_ON_MISSING_CONFIG = true; // an unconfigured priority stays selectable rather than silently disappearing

const reportedGaps = new Set<string>();
function reportConfigGap(departmentId: string | null, priority: string) {
  const key = `${departmentId ?? "null"}:${priority}`;
  if (reportedGaps.has(key)) return;
  reportedGaps.add(key);
  console.error(
    `[priority-config] configuration gap: no ActivityPriorityConfig row for departmentId=${departmentId ?? "null"} priority=${priority}. ` +
    `Resolving sortOrder=${FAILSAFE_SORT_ORDER_ON_MISSING_CONFIG} isEnabled=${FAILSAFE_ENABLED_ON_MISSING_CONFIG} as a fail-safe (fixed for every priority — NOT derived from this priority's name/rank). ` +
    `This should not occur after the full backfill migration; verify this department was created via createDepartment().`
  );
}

export interface PriorityConfigEntry {
  sortOrder: number;
  isEnabled: boolean;
}

type PriorityConfigMap = Record<string, Partial<Record<ActivityPriority, PriorityConfigEntry>>>;

/** Bulk loader — same shape as getActivityTerminalConfigsForDepartments (lib/status-terminal.ts): one query for N departments, no pre-filled defaults. */
export async function getActivityPriorityConfigsForDepartments(departmentIds: string[]): Promise<PriorityConfigMap> {
  const uniqueIds = Array.from(new Set(departmentIds));
  const rows = uniqueIds.length > 0
    ? await prisma.activityPriorityConfig.findMany({ where: { departmentId: { in: uniqueIds } } })
    : [];
  const result: PriorityConfigMap = {};
  for (const id of uniqueIds) result[id] = {};
  for (const row of rows) result[row.departmentId][row.priority] = { sortOrder: row.sortOrder, isEnabled: row.isEnabled };
  return result;
}

export function resolvePriorityConfigEntry(
  configMap: PriorityConfigMap,
  departmentId: string | null,
  priority: ActivityPriority
): PriorityConfigEntry {
  const value = departmentId ? configMap[departmentId]?.[priority] : undefined;
  if (value === undefined) {
    reportConfigGap(departmentId, priority);
    return { sortOrder: FAILSAFE_SORT_ORDER_ON_MISSING_CONFIG, isEnabled: FAILSAFE_ENABLED_ON_MISSING_CONFIG };
  }
  return value;
}

export interface PriorityFilterOption {
  value: ActivityPriority;
  label: string;
}

/**
 * Builds the Priority filter's own option list for ONE specific department,
 * sorted by that department's configured sortOrder, excluding priorities
 * disabled for that department — mirrors exactly how e.g.
 * app/(main)/tickets/page.tsx builds its TicketPriority filter options via
 * `where: { isActive: true }, orderBy: { level: "desc" }`. A record that
 * already carries a disabled priority is NOT affected by this function —
 * disabling only changes what's offered as a NEW selectable option, never
 * what an existing row displays (see components/gantt/gantt-chart.tsx,
 * which renders a child's stored priority regardless of whether it's still
 * enabled — this function only feeds the <Select>'s own option list).
 */
export function buildPriorityFilterOptions(
  configMap: PriorityConfigMap,
  departmentId: string | null
): PriorityFilterOption[] {
  const all = Object.values(ActivityPriority);
  return all
    .map((priority) => ({ priority, entry: resolvePriorityConfigEntry(configMap, departmentId, priority) }))
    .filter(({ entry }) => entry.isEnabled)
    .sort((a, b) => a.entry.sortOrder - b.entry.sortOrder)
    .map(({ priority }) => ({ value: priority, label: ACTIVITY_PRIORITY_LABEL[priority] }));
}

/** Test-only: mirrors lib/status-terminal.ts's own test hook. */
export function __resetReportedGapsForTests(): void {
  reportedGaps.clear();
}
