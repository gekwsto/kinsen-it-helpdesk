import { shiftDateOnly, calendarDaysBetween } from "@/lib/date-only";

/**
 * Resource Planning's drag-and-drop date arithmetic — thin, named wrappers
 * over the app's canonical UTC date-only mechanism in lib/date-only.ts, the
 * SAME one Project Gantt uses, so both timelines (Actual and Expected
 * modes alike) persist identical values for the same move.
 *
 * Dates are date-only values stored at UTC midnight and read by their UTC
 * calendar date (lib/date-only.ts). Shifting therefore operates on that UTC
 * calendar date and always serializes back to exact UTC midnight:
 *   - the intended calendar day is preserved in every browser/server time
 *     zone and across DST transitions (no local wall-clock arithmetic);
 *   - month/year boundaries, every month length and leap years roll over
 *     via Date.UTC;
 *   - shifting a start and finish by the same delta preserves the duration;
 *   - a legacy value carrying a time-of-day keeps its UTC calendar date and
 *     is normalized to midnight only when it is actually moved (stored
 *     records are never rewritten otherwise).
 *
 * Previously this module normalized to LOCAL midnight, which stored a
 * different instant per browser time zone (e.g. 22:00Z the previous UTC day
 * from Athens) and disagreed with the server's own UTC date-only duration
 * calculation — see scripts/test-resource-planning-date-math.ts.
 */
export function shiftActivityDate(iso: string, days: number): string {
  return shiftDateOnly(iso, days);
}

/** Calendar-day duration between two stored activity dates, on their UTC calendar dates. */
export function calendarDurationDays(startIso: string, endIso: string): number {
  return calendarDaysBetween(startIso, endIso);
}
