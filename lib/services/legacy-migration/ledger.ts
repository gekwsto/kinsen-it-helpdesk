/**
 * Thin wrapper around MigrationLedger (prisma/schema.prisma) — the sole
 * idempotency mechanism for scripts/migrate-legacy-ticketapp.ts. Every
 * entity-import function in this directory calls `getLedgerEntry` first and
 * short-circuits to "reuse" on a SUCCEEDED hit, and calls
 * `recordLedgerSuccess`/`recordLedgerFailure` exactly once after attempting
 * a given legacy record — never both for the same (source, entityType,
 * legacyKey).
 */
import type { Prisma, PrismaClient, LegacyMigrationEntityType } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export const LEGACY_MIGRATION_SOURCE = "TICKETAPP_V1";

export async function getLedgerEntry(db: Db, entityType: LegacyMigrationEntityType, legacyKey: string) {
  return db.migrationLedger.findUnique({
    where: { source_entityType_legacyKey: { source: LEGACY_MIGRATION_SOURCE, entityType, legacyKey } },
  });
}

export async function recordLedgerSuccess(
  db: Db,
  entityType: LegacyMigrationEntityType,
  legacyKey: string,
  targetId: string,
  checksum?: string | null
) {
  return db.migrationLedger.upsert({
    where: { source_entityType_legacyKey: { source: LEGACY_MIGRATION_SOURCE, entityType, legacyKey } },
    create: { source: LEGACY_MIGRATION_SOURCE, entityType, legacyKey, targetId, status: "SUCCEEDED", checksum: checksum ?? null, errorMessage: null },
    update: { targetId, status: "SUCCEEDED", checksum: checksum ?? null, errorMessage: null },
  });
}

export async function recordLedgerFailure(db: Db, entityType: LegacyMigrationEntityType, legacyKey: string, errorMessage: string) {
  return db.migrationLedger.upsert({
    where: { source_entityType_legacyKey: { source: LEGACY_MIGRATION_SOURCE, entityType, legacyKey } },
    create: { source: LEGACY_MIGRATION_SOURCE, entityType, legacyKey, targetId: null, status: "FAILED", errorMessage },
    update: { status: "FAILED", errorMessage },
  });
}

/** Every ledger row for this migration source/entityType, as a legacyKey -> targetId map — used to rebuild in-memory lookup maps (username->userId, legacy ticket id->ticketId, ...) on a resumed run without re-deriving them from scratch. */
export async function loadLedgerMap(db: Db, entityType: LegacyMigrationEntityType): Promise<Map<string, string>> {
  const rows = await db.migrationLedger.findMany({
    where: { source: LEGACY_MIGRATION_SOURCE, entityType, status: "SUCCEEDED", targetId: { not: null } },
    select: { legacyKey: true, targetId: true },
  });
  return new Map(rows.map((r) => [r.legacyKey, r.targetId as string]));
}
