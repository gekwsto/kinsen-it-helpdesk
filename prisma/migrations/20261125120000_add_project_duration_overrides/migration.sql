-- Editable Project durations: Expected Total Initial Days + Actual Total Days,
-- each with an automatic (calculated from its dates) / manual override mode.
-- See lib/project-duration.ts.

-- AlterTable (additive only)
ALTER TABLE "Project"
  ADD COLUMN "expectedTotalInitialDaysOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "actualTotalDays" INTEGER,
  ADD COLUMN "actualTotalDaysOverridden" BOOLEAN NOT NULL DEFAULT false;

-- Preserve historical Expected Total Initial Days values. Previously this was
-- an immutable creation-time baseline; it is now recalculated from Expected
-- Start/Finish while in automatic mode. Any existing value that no longer
-- equals the whole-calendar-day difference of its current Expected dates
-- (dates edited after creation, or a date since cleared) is marked as a
-- manual override so it is kept exactly as-is, never silently recalculated.
-- Values that already match stay automatic (identical value). No value is
-- changed by this statement.
UPDATE "Project"
SET "expectedTotalInitialDaysOverridden" = true
WHERE "expectedTotalInitialDays" IS NOT NULL
  AND (
    "expectedStartDate" IS NULL
    OR "expectedFinishDate" IS NULL
    OR "expectedTotalInitialDays" <> ("expectedFinishDate"::date - "expectedStartDate"::date)
  );

-- Populate the NEW actualTotalDays column (automatic mode) from existing
-- Start/End dates — same whole-calendar-day (UTC date) convention as
-- wholeCalendarDaysBetween. Only fills the brand-new column; no existing
-- value is modified. Left NULL when a date is missing or End < Start.
UPDATE "Project"
SET "actualTotalDays" = ("endDate"::date - "startDate"::date)
WHERE "startDate" IS NOT NULL
  AND "endDate" IS NOT NULL
  AND "endDate"::date >= "startDate"::date;
