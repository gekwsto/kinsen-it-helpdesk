-- CreateEnum
CREATE TYPE "PushNotificationType" AS ENUM ('REPLY', 'TERMINAL');

-- CreateEnum
CREATE TYPE "PushNotificationStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED', 'PENDING');

-- CreateTable
CREATE TABLE "PushNotificationLog" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT,
    "userId" TEXT NOT NULL,
    "type" "PushNotificationType" NOT NULL,
    "status" "PushNotificationStatus" NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventKey" TEXT NOT NULL,

    CONSTRAINT "PushNotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushNotificationLog_eventKey_key" ON "PushNotificationLog"("eventKey");

-- CreateIndex
CREATE INDEX "PushNotificationLog_ticketId_idx" ON "PushNotificationLog"("ticketId");

-- CreateIndex
CREATE INDEX "PushNotificationLog_userId_idx" ON "PushNotificationLog"("userId");

-- CreateIndex
CREATE INDEX "PushNotificationLog_createdAt_idx" ON "PushNotificationLog"("createdAt");

-- CreateIndex
CREATE INDEX "PushNotificationLog_type_idx" ON "PushNotificationLog"("type");

-- CreateIndex
CREATE INDEX "PushNotificationLog_status_idx" ON "PushNotificationLog"("status");
