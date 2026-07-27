-- Additive: avatar provenance tracking + Microsoft photo sync metadata.
-- Never removes or renames anything. Safe to re-run.

DO $$ BEGIN
    CREATE TYPE "AvatarSource" AS ENUM ('MICROSOFT', 'MANUAL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarSource" "AvatarSource";
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "microsoftPhotoEtag" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "microsoftPhotoUpdatedAt" TIMESTAMP(3);

-- Backfill: every pre-existing row with a non-null `image` got it exclusively
-- via the Microsoft sign-in flow — there has never been any other write path
-- to User.image in this codebase (no manual upload feature exists). This is
-- a proven fact from the current implementation, not a guess, so it's safe
-- to mark these rows MICROSOFT rather than leaving them ambiguously null.
-- Idempotent: only touches rows that still have avatarSource IS NULL.
UPDATE "User"
SET "avatarSource" = 'MICROSOFT'
WHERE "image" IS NOT NULL AND "avatarSource" IS NULL;
