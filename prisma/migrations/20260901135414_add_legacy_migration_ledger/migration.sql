-- CreateEnum
CREATE TYPE "LegacyMigrationEntityType" AS ENUM ('USER', 'TICKET', 'COMMENT', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "LegacyMigrationStatus" AS ENUM ('SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "MigrationLedger" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entityType" "LegacyMigrationEntityType" NOT NULL,
    "legacyKey" TEXT NOT NULL,
    "targetId" TEXT,
    "status" "LegacyMigrationStatus" NOT NULL,
    "checksum" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationLedger_source_entityType_status_idx" ON "MigrationLedger"("source", "entityType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationLedger_source_entityType_legacyKey_key" ON "MigrationLedger"("source", "entityType", "legacyKey");
