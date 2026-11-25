import { calculateWorkingDays } from "@/lib/date-only";

/**
 * Project duration resolution — the ONE canonical mechanism for both
 * Project duration fields:
 *
 *   Expected Total Initial Days  (expectedStartDate -> expectedFinishDate)
 *     stored as Project.expectedTotalInitialDays / expectedTotalInitialDaysOverridden
 *   Actual Total Days            (startDate -> endDate)
 *     stored as Project.actualTotalDays / actualTotalDaysOverridden
 *
 * Each duration is either AUTOMATIC (overridden = false: the value is the
 * WORKING-DAY count between its own two dates — lib/date-only.ts —
 * recalculated whenever those dates change) or MANUAL (overridden = true:
 * a user-entered non-negative number of working days that date changes
 * never touch). A
 * duration never modifies its dates.
 *
 * Isomorphic (no server-only imports) so the create/edit forms preview the
 * automatic value with exactly the same calculation the server persists.
 * Activity durations are NOT handled here (see lib/date-only.ts).
 */

/** Upper bound for a manual override — well beyond any real Project, guards against absurd input. */
export const MAX_PROJECT_DURATION_DAYS = 100000;

type DateInput = Date | string | null | undefined;

/**
 * The automatic (calculated) duration in WORKING DAYS (Mon–Fri, [start,
 * finish) — see lib/date-only.ts, the single canonical calculation). Null
 * when either date is missing/invalid, or when finish is before start.
 */
export function calculateProjectDurationDays(start: DateInput, finish: DateInput): number | null {
  return calculateWorkingDays(start, finish);
}

export interface ResolvedProjectDuration {
  value: number | null;
  overridden: boolean;
}

/**
 * Resolves the persisted state of one duration.
 *
 * `override`:
 *   - a number    -> manual override with that value (dates ignored)
 *   - null        -> reset to automatic (recalculated from the dates)
 *   - undefined   -> keep the current mode: a manual override stays exactly
 *                    as it is; an automatic value is recalculated from the
 *                    (possibly changed) dates
 *
 * Callers only invoke this when a duration's dates actually CHANGED or the
 * mode is explicitly switched — see PATCH /api/projects/[id].
 */
export function resolveProjectDuration(params: {
  start: DateInput;
  finish: DateInput;
  override: number | null | undefined;
  current?: ResolvedProjectDuration | null;
}): ResolvedProjectDuration {
  const { start, finish, override, current } = params;
  if (typeof override === "number") return { value: override, overridden: true };
  if (override === undefined && current?.overridden) return { value: current.value, overridden: true };
  return { value: calculateProjectDurationDays(start, finish), overridden: false };
}
