-- CreateEnum
CREATE TYPE "OrganizationSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "OrganizationSyncType" AS ENUM ('FULL', 'INCREMENTAL', 'RELATIONSHIP_REFRESH');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "employeeId" TEXT,
ADD COLUMN     "employeeType" TEXT,
ADD COLUMN     "entraAccountEnabled" BOOLEAN,
ADD COLUMN     "entraUserType" TEXT,
ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "managerId" TEXT,
ADD COLUMN     "organizationSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrganizationSyncRun" (
    "id" TEXT NOT NULL,
    "type" "OrganizationSyncType" NOT NULL,
    "status" "OrganizationSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "usersScanned" INTEGER NOT NULL DEFAULT 0,
    "usersUpdated" INTEGER NOT NULL DEFAULT 0,
    "usersSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deltaLink" TEXT,
    "triggeredById" TEXT,

    CONSTRAINT "OrganizationSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSyncLock" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "runId" TEXT,

    CONSTRAINT "OrganizationSyncLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationSyncRun_startedAt_idx" ON "OrganizationSyncRun"("startedAt");

-- CreateIndex
CREATE INDEX "OrganizationSyncRun_status_idx" ON "OrganizationSyncRun"("status");

-- CreateIndex
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
