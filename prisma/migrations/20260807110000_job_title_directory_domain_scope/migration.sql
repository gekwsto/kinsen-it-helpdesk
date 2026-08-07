-- Hand-written (not `prisma migrate dev` auto-generated) — same convention as
-- 20260806090000_organization_multicompany_support: add nullable/defaulted
-- columns, backfill real values for existing rows, then enforce the new
-- compound unique index. Existing single-column `value` unique index is left
-- completely untouched — Operation A/B in microsoft-directory-service.ts
-- (opportunistic per-login cache-fill + the legacy combined admin sync) keep
-- upserting by `where: { value }` exactly as before, unaffected.
--
-- Supports domain-aware Microsoft Job Title auto-discovery
-- (lib/services/microsoft-job-title-directory-service.ts): each Job Title
-- value is now scoped to the Entra domain it was observed in, with a
-- normalized-text uniqueness boundary per domain, and a per-sync eligible
-- user count.

ALTER TABLE "MicrosoftDirectoryJobTitleValue" ADD COLUMN "domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MicrosoftDirectoryJobTitleValue" ADD COLUMN "normalizedValue" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MicrosoftDirectoryJobTitleValue" ADD COLUMN "userCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill: every pre-existing row was only ever populated by
-- domain-gated Microsoft SSO users (lib/auth.ts already restricts sign-in
-- to @<ALLOWED_EMAIL_DOMAIN>), so 'kinsen.gr' — the domain configured at the
-- time this migration was written — is the correct historical value, not a
-- guess. normalizedValue mirrors the exact trim+collapse-space+lowercase
-- normalization lib/services/microsoft-job-title-directory-service.ts uses
-- going forward, so pre-existing rows compare consistently with newly
-- discovered ones from the very next sync.
UPDATE "MicrosoftDirectoryJobTitleValue"
SET "domain" = 'kinsen.gr',
    "normalizedValue" = lower(trim(regexp_replace("value", '\s+', ' ', 'g')));

CREATE UNIQUE INDEX "MicrosoftDirectoryJobTitleValue_domain_normalizedValue_key" ON "MicrosoftDirectoryJobTitleValue" ("domain", "normalizedValue");
CREATE INDEX "MicrosoftDirectoryJobTitleValue_domain_idx" ON "MicrosoftDirectoryJobTitleValue" ("domain");
