-- Splits the single requester-filled "businessAssessment" into two
-- independent fields, preserving ALL existing data (non-destructive):
--
-- 1. The old requester-filled businessAssessment column is loosened to
--    nullable (no NEW row will ever populate it) and renamed to
--    legacyRequesterBusinessAssessment — every pre-existing value is kept
--    verbatim, now read-only legacy data.
-- 2. The optional decision "comment" column is renamed to
--    businessAssessment — it becomes the approver's own MANDATORY
--    (enforced at the application level) assessment, written at decision
--    time. Any pre-existing comment text is preserved verbatim under its
--    new name.
--
-- Pure metadata operations (ALTER COLUMN DROP NOT NULL, two RENAME
-- COLUMNs) — no data is moved, copied, or dropped.

ALTER TABLE "ProjectRequest" ALTER COLUMN "businessAssessment" DROP NOT NULL;
ALTER TABLE "ProjectRequest" RENAME COLUMN "businessAssessment" TO "legacyRequesterBusinessAssessment";
ALTER TABLE "ProjectRequest" RENAME COLUMN "comment" TO "businessAssessment";
