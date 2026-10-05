-- Adds ProjectActivity.sequence — the user-controlled execution/priority
-- ORDER of an Activity within its parent Project's vertical list, for
-- request-origin Projects only (Project.projectRequestId != null). See
-- lib/services/activity-sequence-service.ts for the single authoritative
-- read/write path.
--
-- Nullable at the DB level (a standalone Activity or one under a manual
-- Project never has it set — ordering is meaningless there). For EXISTING
-- request-origin Activities, this migration safely backfills a
-- deterministic initial sequence (1, 2, 3, ... per Project, ordered by
-- createdAt ASC — the most stable existing field, i.e. creation order) so
-- the visible sequence is never arbitrary/DB-ordering-dependent from the
-- moment this ships. Manual-Project Activities are deliberately left NULL
-- forever (never backfilled) — the feature does not apply to them.
--
-- Purely additive/safe: no existing column is touched, and the backfill
-- only ever fills a previously-nonexistent column with a fresh ordinal —
-- there is no "old value" it could discard.

-- AlterTable
ALTER TABLE "ProjectActivity" ADD COLUMN     "sequence" INTEGER;

-- CreateIndex
CREATE INDEX "ProjectActivity_projectId_sequence_idx" ON "ProjectActivity"("projectId", "sequence");

-- Backfill: request-origin Activities only, ordered by createdAt ASC per Project.
UPDATE "ProjectActivity" AS pa
SET "sequence" = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "ProjectActivity"
  WHERE "projectId" IN (SELECT id FROM "Project" WHERE "projectRequestId" IS NOT NULL)
) AS ranked
WHERE pa.id = ranked.id;
