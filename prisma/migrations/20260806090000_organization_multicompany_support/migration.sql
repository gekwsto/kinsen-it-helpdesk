-- Hand-written (not `prisma migrate dev` auto-generated) — same convention
-- as 20260803000000_add_user_email_case_insensitive_unique: Prisma refuses
-- to non-interactively add a required+unique column to a table that already
-- has rows without a default, so this does it in the correct order by hand:
-- add nullable -> backfill -> enforce NOT NULL/UNIQUE.
--
-- Supports the Microsoft Directory Sync multi-company feature
-- (lib/services/organization-directory-sync-service.ts): a Company can now
-- be matched/created purely from Entra's free-text companyName (no domain
-- available), and a Department can attach directly to a Company when there's
-- no meaningful BusinessUnit to nest under (always true for Entra data,
-- which has no "business unit" concept).

-- ── User: Entra givenName/surname, distinct from the existing `name` (display name) ──
ALTER TABLE "User" ADD COLUMN "givenName" TEXT;
ALTER TABLE "User" ADD COLUMN "surname" TEXT;

-- ── Company: domain becomes optional (a Microsoft-sourced company has none); ──
-- ── normalizedName becomes the real duplicate-prevention backstop.          ──
ALTER TABLE "Company" ALTER COLUMN "domain" DROP NOT NULL;

ALTER TABLE "Company" ADD COLUMN "normalizedName" TEXT;
-- Backfill: trim + collapse internal whitespace + lowercase, matching
-- lib/services/organization-normalization.ts's normalizeCompanyName exactly.
-- Confirmed via direct introspection before writing this migration: exactly
-- one Company row exists ("Kinsen"), zero would collide — safe to enforce
-- NOT NULL + UNIQUE immediately after this single UPDATE.
UPDATE "Company" SET "normalizedName" = lower(trim(regexp_replace(name, '\s+', ' ', 'g')));
ALTER TABLE "Company" ALTER COLUMN "normalizedName" SET NOT NULL;
CREATE UNIQUE INDEX "Company_normalizedName_key" ON "Company" ("normalizedName");

-- ── Department: direct Company placement (no BusinessUnit) + normalizedName ──
-- for the same duplicate-prevention purpose, scoped to this new path only.
ALTER TABLE "Department" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Department" ADD COLUMN "normalizedName" TEXT;
-- Backfill existing departments too (keeps the column meaningful app-wide;
-- lib/services/department-service.ts's createDepartment/updateDepartment
-- keep it in sync going forward) — this column stays nullable at the schema
-- level (some future write path could theoretically omit it), so no NOT
-- NULL is enforced here, only the composite unique index below, which is
-- inherently safe to add: `companyId` is brand new and NULL on every
-- existing row, and Postgres never treats two NULLs as colliding in a
-- unique index — this can never fail on existing data.
UPDATE "Department" SET "normalizedName" = lower(trim(regexp_replace(name, '\s+', ' ', 'g')));

ALTER TABLE "Department" ADD CONSTRAINT "Department_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Department_companyId_normalizedName_key" ON "Department" ("companyId", "normalizedName");
CREATE INDEX "Department_companyId_idx" ON "Department" ("companyId");
