import { addDays, differenceInCalendarDays } from "date-fns";

/**
 * Central date-only arithmetic for Resource Planning's drag-and-drop date
 * shift (and anywhere else that needs the same guarantee). Two operations:
 * shifting a stored activity date by a whole number of days, and measuring
 * the calendar-day duration between two stored dates.
 *
 * WHY this is safe across month/year boundaries, every month length,
 * leap years, and DST: it's built on date-fns's addDays/
 * differenceInCalendarDays, which operate on the JS Date's LOCAL calendar
 * fields (year/month/date) — never a raw millisecond offset divided by
 * 86400000, and never getDate()/setDate() called directly with hand-rolled
 * carry logic. JS's own Date.setDate() (which addDays is built on) natively
 * rolls over month/year boundaries per the actual Gregorian calendar (e.g.
 * Jan 31 + 1 day => Feb 1, unconditionally correct for every month length
 * and every leap year) and is DST-aware by construction (the browser/Node
 * runtime resolves local wall-clock fields correctly across a DST
 * transition). This is not an assumption — see
 * scripts/test-resource-planning-date-math.ts, which checks this exact
 * behavior against real Date objects for: a simple month crossing, a year
 * crossing, every month-length boundary (28/29/30/31), a leap-year and a
 * non-leap-year February 28th, and both the spring-forward and fall-back
 * DST transition dates.
 *
 * Re-normalizing the shifted result to local midnight (rather than
 * preserving whatever time-of-day component the input happened to carry)
 * exists purely to prevent drift: without it, repeated drags on the same
 * activity could each carry forward a few minutes/hours of time-of-day
 * noise (e.g. from a value that was never exactly midnight to begin with),
 * which given enough repetitions could eventually push the stored instant
 * across a local-midnight boundary and silently read back as the wrong
 * calendar day. Normalizing on every shift makes that structurally
 * impossible — the output is always exactly local midnight of the intended
 * calendar day.
 */
export function shiftActivityDate(iso: string, days: number): string {
  const shifted = addDays(new Date(iso), days);
  shifted.setHours(0, 0, 0, 0);
  return shifted.toISOString();
}

/** Calendar-day duration between two stored activity dates (local calendar days — see shiftActivityDate for why this is DST/month/year-safe). */
export function calendarDurationDays(startIso: string, endIso: string): number {
  return differenceInCalendarDays(new Date(endIso), new Date(startIso));
}
