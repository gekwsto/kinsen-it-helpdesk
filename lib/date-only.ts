/**
 * Whole calendar days between two date-only values, DST/local-time safe —
 * both inputs are normalized to UTC midnight before differencing, so a DST
 * transition occurring somewhere in between can never shift the result by an
 * hour and round to the wrong day.
 *
 * 2026-10-01 -> 2026-10-01 = 0
 * 2026-10-01 -> 2026-10-02 = 1
 *
 * Extracted from lib/services/project-request-service.ts (originally
 * module-private there, used only for Project.expectedTotalInitialDays) so
 * it can be reused verbatim — same inputs, same outputs, zero behavior
 * change — for Activity.expectedDays and Activity.actualDays, instead of
 * duplicating the calculation a second time.
 */
export function wholeCalendarDaysBetween(start: Date, finish: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startUtcMidnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const finishUtcMidnight = Date.UTC(finish.getUTCFullYear(), finish.getUTCMonth(), finish.getUTCDate());
  return Math.round((finishUtcMidnight - startUtcMidnight) / MS_PER_DAY);
}

/**
 * Activity.actualDays — Expected Start -> the real COMPLETED transition's
 * own completedAt, clamped to a minimum of 0.
 *
 * Unlike Expected Days (expectedFinishDate - expectedStartDate, where
 * creation/edit validation already guarantees finish >= start, so a
 * negative result there is already impossible), Actual Days has no such
 * guarantee: an Activity can legitimately be completed on any real
 * calendar date, including one BEFORE its own Expected Start (an early/
 * ahead-of-schedule completion). A raw wholeCalendarDaysBetween there
 * would go negative, which then multiplies through taskSubTypeCost into a
 * negative Activity Actual Cost and, summed, a negative Project Actual
 * Cost — invalid business values no currency/cost field in this app
 * should ever show. The business MEANING of "completed early" is "zero
 * elapsed days," not a negative duration, so this is a floor, never a
 * reinterpretation of the Expected-Start-to-completedAt formula itself.
 *
 * THE single authoritative place Activity.actualDays is ever computed —
 * both POST /api/activities (create-as-COMPLETED) and PATCH
 * /api/activities/[id] (the real completion-transition boundary every
 * completion UI path — the checkbox, the quick-status dropdown — funnels
 * through) call this, never wholeCalendarDaysBetween directly for this
 * purpose.
 */
export function actualDaysFromCompletion(expectedStartDate: Date, completedAt: Date): number {
  return Math.max(0, wholeCalendarDaysBetween(expectedStartDate, completedAt));
}
