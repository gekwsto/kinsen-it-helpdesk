-- CreateEnum
CREATE TYPE "OrganizationNodeSource" AS ENUM ('SQLGENERAL');

-- CreateEnum
CREATE TYPE "SqlGeneralUserSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED_PERMANENT', 'SKIPPED_NO_USERNAME');

-- AlterEnum
ALTER TYPE "MembershipSource" ADD VALUE 'SQLGENERAL_DEPARTMENT';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "importRunId" TEXT,
ADD COLUMN     "importSource" "OrganizationNodeSource",
ADD COLUMN     "importedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "importRunId" TEXT,
ADD COLUMN     "importSource" "OrganizationNodeSource",
ADD COLUMN     "importedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SqlGeneralUserSyncAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SqlGeneralUserSyncStatus" NOT NULL DEFAULT 'PENDING',
    "sqlGeneralUsername" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SqlGeneralUserSyncAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SqlGeneralUserSyncAttempt_userId_key" ON "SqlGeneralUserSyncAttempt"("userId");

-- CreateIndex
CREATE INDEX "SqlGeneralUserSyncAttempt_status_idx" ON "SqlGeneralUserSyncAttempt"("status");

-- AddForeignKey
ALTER TABLE "SqlGeneralUserSyncAttempt" ADD CONSTRAINT "SqlGeneralUserSyncAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
