-- CreateEnum
CREATE TYPE "DurationBackfillRunStatus" AS ENUM ('APPLIED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "DurationBackfillRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "DurationBackfillRunStatus" NOT NULL DEFAULT 'APPLIED',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL,

    CONSTRAINT "DurationBackfillRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DurationBackfillChange" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "oldValue" INTEGER,
    "newValue" INTEGER,
    "oldOverridden" BOOLEAN,
    "newOverridden" BOOLEAN,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "DurationBackfillChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DurationBackfillChange_entity_recordId_idx" ON "DurationBackfillChange"("entity", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "DurationBackfillChange_runId_entity_recordId_field_key" ON "DurationBackfillChange"("runId", "entity", "recordId", "field");

-- AddForeignKey
ALTER TABLE "DurationBackfillChange" ADD CONSTRAINT "DurationBackfillChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DurationBackfillRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
