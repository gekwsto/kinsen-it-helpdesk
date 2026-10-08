-- Project Feedback replacement: the single 1-10 satisfactionScore is
-- replaced by five independent 1-5 ratings (delivery speed, communication,
-- functionality, ease of use, overall) plus a separate explicit
-- requirementsDelivered boolean — see prisma/schema.prisma's
-- ProjectFeedback model doc comment for the full business rule and the new
-- Greek-labeled form this now backs.
--
-- Non-destructive: the OLD satisfactionScore column is RENAMED (never
-- dropped) to legacySatisfactionScore and made NULLABLE, preserving every
-- historical submission's real value forever — never fabricated into the
-- five new ratings, which simply stay null on every pre-existing row (no
-- truthful per-dimension breakdown can be derived from a single historical
-- score). comments is left completely untouched (same column, same
-- meaning, reused by the new form as well). At the time this migration was
-- written, this table had 0 rows in the dev DB — but the rename strategy
-- below is written to safely preserve real data regardless.
ALTER TABLE "ProjectFeedback" RENAME COLUMN "satisfactionScore" TO "legacySatisfactionScore";
ALTER TABLE "ProjectFeedback" ALTER COLUMN "legacySatisfactionScore" DROP NOT NULL;

-- New fields — nullable at the DB level ONLY because every EXISTING row
-- (submitted under the old single-score model) can never be safely
-- backfilled with fabricated per-dimension values; required at the
-- application boundary for every NEW submission going forward (see
-- projectFeedbackSchema in lib/validations.ts), the same "nullable at DB,
-- required at creation" pattern this schema already uses throughout
-- (TaskSubType.cost, ProjectActivity.taskTypeId, etc).
ALTER TABLE "ProjectFeedback" ADD COLUMN "deliverySpeedRating" INTEGER;
ALTER TABLE "ProjectFeedback" ADD COLUMN "communicationRating" INTEGER;
ALTER TABLE "ProjectFeedback" ADD COLUMN "functionalityRating" INTEGER;
ALTER TABLE "ProjectFeedback" ADD COLUMN "easeOfUseRating" INTEGER;
ALTER TABLE "ProjectFeedback" ADD COLUMN "overallRating" INTEGER;
ALTER TABLE "ProjectFeedback" ADD COLUMN "requirementsDelivered" BOOLEAN;

-- Feedback is now an EDITABLE record (the original requester may update
-- their own submission while the Project is COMPLETED) — previously
-- immutable, with no updatedAt column at all. Existing rows are backfilled
-- to their own createdAt-equivalent moment via DEFAULT CURRENT_TIMESTAMP;
-- Prisma Client maintains it on every subsequent update() going forward.
ALTER TABLE "ProjectFeedback" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
