-- CreateEnum
CREATE TYPE "SqlGeneralTreeSnapshotStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SqlGeneralTreeSnapshotTrigger" AS ENUM ('CRON', 'MANUAL');

-- CreateTable
CREATE TABLE "SqlGeneralOrganizationTreeSnapshot" (
    "id" TEXT NOT NULL,
    "status" "SqlGeneralTreeSnapshotStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "treeData" JSONB,
    "rootCount" INTEGER,
    "nodeCount" INTEGER,
    "unresolvedUserCount" INTEGER,
    "unresolvedManagerLinkCount" INTEGER,
    "lastError" TEXT,
    "triggeredBy" "SqlGeneralTreeSnapshotTrigger" NOT NULL,
    "triggeredById" TEXT,

    CONSTRAINT "SqlGeneralOrganizationTreeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SqlGeneralTreeSnapshotLock" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "runId" TEXT,

    CONSTRAINT "SqlGeneralTreeSnapshotLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SqlGeneralOrganizationTreeSnapshot_status_completedAt_idx" ON "SqlGeneralOrganizationTreeSnapshot"("status", "completedAt");

-- CreateIndex
CREATE INDEX "SqlGeneralOrganizationTreeSnapshot_startedAt_idx" ON "SqlGeneralOrganizationTreeSnapshot"("startedAt");
