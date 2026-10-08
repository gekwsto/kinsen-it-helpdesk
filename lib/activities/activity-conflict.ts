/**
 * Same-day-start warning (non-blocking, see ProjectActivity.expectedStartDate
 * in prisma/schema.prisma) — an Activity warns when at least one OTHER
 * Activity in the SAME Project shares its Expected Start date AND both are
 * currently active (not completed).
 *
 * `isCompleted` is the canonical completion flag — it tracks the real
 * COMPLETED status transition (see POST /api/activities and PATCH
 * /api/activities/[id]'s own `createdAsCompleted`/`completing` derivation),
 * never the separately-configurable per-department ActivityStatusConfig.
 * isTerminal used elsewhere for dashboard counts — this feature intentionally
 * reuses the SAME boolean that already gates actualDays/actualCost, not that
 * unrelated per-department concept.
 *
 * Pure and DB-free (no Prisma import) on purpose: it is called both from a
 * server component (app/(main)/projects/[id]/page.tsx, for the initial
 * render) and reactively from a client component
 * (components/projects/project-activity-sequence-card.tsx, recomputed via
 * useMemo any time a row's isCompleted changes after a completion toggle —
 * so a warning disappears/reappears immediately, with no extra fetch).
 *
 * Callers MUST already scope `activities` to a single Project — this
 * function performs no Project filtering of its own; comparing across
 * Projects is explicitly out of scope for this feature.
 *
 * No conflict state is ever persisted — this is recomputed from canonical
 * data (expectedStartDate, isCompleted) on every call, never stored.
 */
export interface SameDayStartCandidate {
  id: string;
  expectedStartDate: Date | string | null;
  isCompleted: boolean;
}

export interface SameDayStartWarning {
  hasSameDayStartWarning: boolean;
  /** OTHER active Activities (same Project, same day) — never includes the Activity itself. */
  sameDayStartActiveCount: number;
}

function dayKeyOf(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
}

export function computeSameDayStartWarnings<T extends SameDayStartCandidate>(
  activities: readonly T[]
): Map<string, SameDayStartWarning> {
  // Active (not completed), real-dated Activities only, grouped by calendar
  // day — a completed Activity or one with no expectedStartDate never joins
  // a group, so it can never cause (or receive) a warning.
  const activeIdsByDay = new Map<string, string[]>();
  for (const activity of activities) {
    if (activity.isCompleted || !activity.expectedStartDate) continue;
    const key = dayKeyOf(activity.expectedStartDate);
    const ids = activeIdsByDay.get(key);
    if (ids) ids.push(activity.id);
    else activeIdsByDay.set(key, [activity.id]);
  }

  const result = new Map<string, SameDayStartWarning>();
  for (const activity of activities) {
    if (activity.isCompleted || !activity.expectedStartDate) {
      result.set(activity.id, { hasSameDayStartWarning: false, sameDayStartActiveCount: 0 });
      continue;
    }
    const sameDayIds = activeIdsByDay.get(dayKeyOf(activity.expectedStartDate)) ?? [activity.id];
    const otherActiveCount = sameDayIds.length - 1;
    result.set(activity.id, { hasSameDayStartWarning: otherActiveCount > 0, sameDayStartActiveCount: otherActiveCount });
  }
  return result;
}
