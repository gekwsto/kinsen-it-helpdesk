/**
 * THE canonical duration calculation for every date-derived duration in
 * this app — Project Expected Total Initial Days / Actual Total Days (via
 * lib/project-duration.ts), Activity Expected Days / Actual Days, their
 * client-side previews, and historical import. Isomorphic (no imports), so
 * the browser previews and the server persist exactly the same number.
 *
 * Durations are WORKING DAYS: Monday–Friday count, Saturday/Sunday never
 * do. Public holidays are NOT excluded.
 *
 * Boundary convention (unchanged from the previous calendar-day rule,
 * finish - start): the half-open range [start, finish) — the start day
 * counts, the finish day does not. So a same-day range is 0, and
 *   Mon 2026-10-05 -> Fri 2026-10-09 = 4   (Mon, Tue, Wed, Thu)
 *   Fri 2026-10-09 -> Mon 2026-10-12 = 1   (Fri)
 *   Sat 2026-10-10 -> Mon 2026-10-12 = 0   (weekend only)
 * (identical to numpy.busday_count's convention).
 *
 * UTC date-only arithmetic: both inputs are reduced to their UTC calendar
 * date (how every date-only value in this app is stored — UTC midnight)
 * before counting, so local time zones and DST transitions can never shift
 * the result.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days since 1970-01-01 (a Thursday) of the value's UTC calendar date. */
function utcDayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS_PER_DAY);
}

/** 0 = Sunday … 6 = Saturday, for a utcDayNumber. Day 0 (1970-01-01) was a Thursday (4). */
function weekdayOf(dayNumber: number): number {
  return (((dayNumber + 4) % 7) + 7) % 7;
}

/** Working days in [from, to) for day numbers with from <= to. O(1). */
function countWorkingDays(from: number, to: number): number {
  const span = to - from;
  const fullWeeks = Math.floor(span / 7);
  let count = fullWeeks * 5;
  for (let day = from + fullWeeks * 7; day < to; day++) {
    const dow = weekdayOf(day);
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

/**
 * Working days (Mon–Fri) between two dates, [start, finish) — see this
 * module's doc comment. Signed, like the calendar difference it replaces:
 * a finish before its start yields the NEGATED count, so every caller's
 * existing "reversed range" handling (rejected, clamped to 0, or null)
 * keeps working unchanged.
 */
export function workingDaysBetween(start: Date, finish: Date): number {
  const a = utcDayNumber(start);
  const b = utcDayNumber(finish);
  return b >= a ? countWorkingDays(a, b) : -countWorkingDays(b, a);
}

type DateInput = Date | string | null | undefined;

function toValidDate(value: DateInput): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Null-safe working-day duration for form/date-only inputs: null when
 * either date is missing or invalid, or when finish is before start (no
 * valid duration). Used by the Project duration resolver and every
 * client-side preview.
 */
export function calculateWorkingDays(start: DateInput, finish: DateInput): number | null {
  const s = toValidDate(start);
  const f = toValidDate(finish);
  if (!s || !f) return null;
  const days = workingDaysBetween(s, f);
  return days < 0 ? null : days;
}

/** True when both values denote the same UTC calendar date (or are both null/undefined). */
export function isSameDateOnly(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return utcDayNumber(a) === utcDayNumber(b);
}

/**
 * Activity.actualDays — working days from the start reference (Expected
 * Start, else Actual Start) to the real COMPLETED transition's own
 * completedAt, clamped to a minimum of 0.
 *
 * Unlike Expected Days (where creation/edit validation already guarantees
 * finish >= start), an Activity can legitimately be completed BEFORE its
 * own start reference (an early/ahead-of-schedule completion). The
 * business meaning of "completed early" is "zero elapsed days", never a
 * negative duration (which would multiply through taskSubTypeCost into a
 * negative cost), so this is a floor, never a reinterpretation.
 *
 * THE single authoritative place Activity.actualDays is ever computed —
 * both POST /api/activities (create-as-COMPLETED) and PATCH
 * /api/activities/[id] (the real completion-transition boundary) call this.
 */
export function actualDaysFromCompletion(startReference: Date, completedAt: Date): number {
  return Math.max(0, workingDaysBetween(startReference, completedAt));
}

/**
 * Canonical date-only serialization: the value's UTC calendar date as an
 * ISO string at exact UTC midnight ("YYYY-MM-DDT00:00:00.000Z") — how every
 * date-only value in this app is stored and read (see this module's doc
 * comment). A legacy value carrying a time-of-day keeps its UTC calendar
 * date; only the time component is dropped. Never depends on the runtime's
 * local time zone or DST.
 */
export function toDateOnlyIso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Shifts a date-only value by a whole number of calendar days on its UTC
 * calendar date and serializes the result canonically (toDateOnlyIso).
 * THE shared scheduling shift for timeline drag-and-drop (Project Gantt
 * and Resource Planning, Actual and Expected): the same intended calendar
 * day results in every browser/server time zone and across DST, and
 * shifting a start and finish by the same delta preserves their duration
 * exactly. Month/year boundaries, month lengths and leap years are handled
 * by Date.UTC's own calendar rollover.
 */
export function shiftDateOnly(value: Date | string, days: number): string {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days)).toISOString();
}

/** Whole calendar days from start to finish, on their UTC calendar dates (signed). */
export function calendarDaysBetween(start: Date | string, finish: Date | string): number {
  const a = start instanceof Date ? start : new Date(start);
  const b = finish instanceof Date ? finish : new Date(finish);
  return utcDayNumber(b) - utcDayNumber(a);
}

/**
 * Rendering bridge for date-only values: a Date at LOCAL noon on the value's
 * UTC calendar date. Local-time calendar helpers (date-fns format,
 * differenceInCalendarDays, isSameDay, startOfMonth, …) then see exactly the
 * stored calendar day in every browser/server time zone, so the server
 * render and the client hydration agree and New York shows the same day as
 * Athens. Noon (not midnight) keeps it clear of DST transitions that skip a
 * local midnight. For DATE-ONLY values only — never for genuine timestamps
 * (audit events, notifications, completedAt, createdAt), which must keep
 * their local-time rendering.
 */
export function dateOnlyAsLocalDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
}
