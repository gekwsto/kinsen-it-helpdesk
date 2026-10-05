-- Data correction only — no schema change. Fixes a real bug: an Activity
-- completed BEFORE its own Expected Start produced a NEGATIVE
-- ProjectActivity.actualDays (raw wholeCalendarDaysBetween(expectedStart,
-- completedAt) was never floored), which then multiplied through
-- taskTypeCost into a negative Activity Actual Cost and, summed, a
-- negative Project Actual Cost (confirmed live: one real row in this
-- database had actualDays = -2, producing an actual Project Actual Cost
-- of -€300.00). The application-level fix lives in
-- lib/date-only.ts's new actualDaysFromCompletion() helper (Math.max(0, ...)),
-- used by both app/api/activities/route.ts and
-- app/api/activities/[id]/route.ts — the two (and only two) places
-- actualDays is ever computed. That fix only prevents NEW negative values;
-- it cannot retroactively correct rows already persisted before it shipped,
-- since Project Actual Cost is derived fresh from the CURRENT stored
-- actualDays on every read.
--
-- Scope: ONLY rows where "actualDays" < 0 are touched, and ONLY that one
-- column is set to 0 — completedAt is never altered (no completion
-- timestamp is fabricated or removed), and every valid positive or null
-- actualDays value is left completely untouched. At the time this
-- migration was written, exactly 1 row in this local/dev database matched
-- (actualDays = -2, on a request-origin Activity whose Project's Actual
-- Cost was consequently showing -€300.00).
UPDATE "ProjectActivity"
SET "actualDays" = 0
WHERE "actualDays" < 0;
