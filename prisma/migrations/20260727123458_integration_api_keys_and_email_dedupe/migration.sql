-- RECONSTRUCTED migration file — this migration was actually applied to the
-- shared dev database on 2026-07-27 (confirmed via _prisma_migrations) as
-- part of an earlier "External Integration Layer" effort that was later
-- explicitly abandoned/reverted at the filesystem level (its plan file,
-- routes, and this migration folder were all removed from the repo), but
-- the database itself — a separate, persistent service — kept the schema
-- changes it had already applied. This file recreates exactly what's
-- currently in the database (confirmed via information_schema/pg_indexes
-- introspection) so the migration ledger is consistent again and
-- `prisma migrate dev`/`deploy` can proceed without drift errors.
--
-- This migration is NOT part of the current External Integrations feature
-- (see the later add_external_integrations migration) — it exists purely to
-- reconcile history. The very next migration drops IntegrationApiKey/
-- IntegrationAuditLog/IntegrationIdempotencyRecord again (they're dead,
-- unreferenced-by-any-code tables from the abandoned effort — confirmed via
-- repo-wide search finding zero references — containing zero real API keys
-- and zero idempotency records, only 285 rows of automated test HTTP-call
-- logging from that one 2026-07-27 test session) and reverts
-- TicketMessage.emailMessageId back to a plain (non-unique) index, matching
-- this repo's current, documented intent (see that field's own comment in
-- schema.prisma: dedup for TicketMessage is deliberately app-level only).

CREATE TABLE IF NOT EXISTS "IntegrationApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "allowedScopes" TEXT[],
    "allDepartments" BOOLEAN NOT NULL DEFAULT false,
    "departmentIds" TEXT[],
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationApiKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "IntegrationAuditLog" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "keyPrefixSnapshot" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "scope" TEXT,
    "departmentId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "actorUserId" TEXT,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "IntegrationIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationApiKey_keyHash_key" ON "IntegrationApiKey"("keyHash");
CREATE INDEX IF NOT EXISTS "IntegrationApiKey_isActive_idx" ON "IntegrationApiKey"("isActive");
CREATE INDEX IF NOT EXISTS "IntegrationAuditLog_apiKeyId_idx" ON "IntegrationAuditLog"("apiKeyId");
CREATE INDEX IF NOT EXISTS "IntegrationAuditLog_createdAt_idx" ON "IntegrationAuditLog"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationIdempotencyRecord_apiKeyId_idempotencyKey_key" ON "IntegrationIdempotencyRecord"("apiKeyId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "IntegrationIdempotencyRecord_expiresAt_idx" ON "IntegrationIdempotencyRecord"("expiresAt");

DO $$ BEGIN
    ALTER TABLE "IntegrationApiKey" ADD CONSTRAINT "IntegrationApiKey_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "IntegrationAuditLog" ADD CONSTRAINT "IntegrationAuditLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "IntegrationApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "IntegrationIdempotencyRecord" ADD CONSTRAINT "IntegrationIdempotencyRecord_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "IntegrationApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Matches what's actually in the DB today: a UNIQUE index on
-- TicketMessage.emailMessageId (upgraded from the plain index the earlier,
-- still-on-disk migrations created). The very next migration reverts this
-- back to a plain index, restoring this repo's current documented intent.
DROP INDEX IF EXISTS "TicketMessage_emailMessageId_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "TicketMessage_emailMessageId_key" ON "TicketMessage"("emailMessageId");
