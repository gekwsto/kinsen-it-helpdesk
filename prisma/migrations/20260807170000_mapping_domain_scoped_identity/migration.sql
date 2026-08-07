-- Hand-written (not `prisma migrate dev` auto-generated), same convention as
-- 20260807110000_job_title_directory_domain_scope /
-- 20260807153000_job_title_value_domain_scoped_identity.
--
-- FIND-006 (docs/roadmap-handoff-register.md): MicrosoftDepartmentMapping's
-- canonical identity moves from `(sourceType, microsoftValue)` to
-- `(sourceType, domain, normalizedMicrosoftValue)` so a PROFILE_JOB_TITLE
-- mapping can, in the future, differ per Entra domain (e.g. a "Director"
-- mapping for kinsen.gr independent of one for kinsen.at) without a further
-- schema change. Every other sourceType (PROFILE_DEPARTMENT, ENTRA_GROUP,
-- ENTRA_APP_ROLE) deliberately stays global — see the model's own schema
-- comment in prisma/schema.prisma for the full per-sourceType reasoning.

ALTER TABLE "MicrosoftDepartmentMapping" ADD COLUMN "domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "MicrosoftDepartmentMapping" ADD COLUMN "normalizedMicrosoftValue" TEXT NOT NULL DEFAULT '';

-- Backfill, deterministic per sourceType — mirrors the exact reasoning
-- already used and verified for MicrosoftDirectoryJobTitleValue's own
-- domain backfill (20260807110000_job_title_directory_domain_scope):
--
-- Every PROFILE_JOB_TITLE mapping that could ever exist in this table was
-- created through this application's own admin UI
-- (components/admin/microsoft-mapping-management.tsx /
-- app/api/admin/microsoft-mappings/**), which has only ever operated
-- against a single-tenant deployment gated to `ALLOWED_EMAIL_DOMAIN`
-- (Microsoft SSO itself is domain-gated in lib/auth.ts, unchanged since
-- before this feature existed) — there was never a code path capable of
-- creating a mapping for any OTHER domain. Backfilling every existing
-- PROFILE_JOB_TITLE row to 'kinsen.gr' (the domain configured at the time
-- this migration was written) is therefore the historically correct value,
-- not a guess. At the time this migration was authored, a direct query
-- confirmed ZERO existing PROFILE_JOB_TITLE rows in the reference database
-- — this UPDATE is written generally (not skipped) so it is also correct
-- against any OTHER deployment's real data.
--
-- Every other sourceType gets domain = '' (the "global" sentinel — see the
-- model's schema comment for why '' and not NULL) and
-- normalizedMicrosoftValue = an EXACT copy of microsoftValue (their matching
-- semantics are untouched, byte-for-byte).
UPDATE "MicrosoftDepartmentMapping"
SET "domain" = 'kinsen.gr',
    "normalizedMicrosoftValue" = lower(trim(regexp_replace("microsoftValue", '\s+', ' ', 'g')))
WHERE "sourceType" = 'PROFILE_JOB_TITLE';

UPDATE "MicrosoftDepartmentMapping"
SET "domain" = '',
    "normalizedMicrosoftValue" = "microsoftValue"
WHERE "sourceType" != 'PROFILE_JOB_TITLE';

-- Replace the old 2-column unique index with the new 3-column one — this is
-- what actually allows the same raw job title text to exist once per
-- domain going forward. Dropping/creating an index never touches row data.
DROP INDEX "MicrosoftDepartmentMapping_sourceType_microsoftValue_key";
CREATE UNIQUE INDEX "MicrosoftDepartmentMapping_sourceType_domain_normalizedMicrosoftValue_key" ON "MicrosoftDepartmentMapping" ("sourceType", "domain", "normalizedMicrosoftValue");
CREATE INDEX "MicrosoftDepartmentMapping_domain_idx" ON "MicrosoftDepartmentMapping" ("domain");
