-- CreateEnum
CREATE TYPE "EmailNotificationType" AS ENUM ('REPLY', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmailNotificationStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "EmailNotificationLog" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "type" "EmailNotificationType" NOT NULL,
    "status" "EmailNotificationStatus" NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailNotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailNotificationLog_ticketId_idx" ON "EmailNotificationLog"("ticketId");

-- CreateIndex
CREATE INDEX "EmailNotificationLog_createdAt_idx" ON "EmailNotificationLog"("createdAt");

-- CreateIndex
CREATE INDEX "EmailNotificationLog_type_idx" ON "EmailNotificationLog"("type");

-- CreateIndex
CREATE INDEX "EmailNotificationLog_status_idx" ON "EmailNotificationLog"("status");
