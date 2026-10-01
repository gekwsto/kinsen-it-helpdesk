-- Adds the nullable `replacementDescription` column to ProjectRequest —
-- additive, no data migration needed: every existing row gets NULL, which
-- is exactly the correct/valid value for a request where replacesExisting
-- is false (the column is only ever populated when replacesExisting is
-- true, enforced server-side in createProjectRequestSchema, lib/validations.ts).

-- AlterTable
ALTER TABLE "ProjectRequest" ADD COLUMN     "replacementDescription" TEXT;
