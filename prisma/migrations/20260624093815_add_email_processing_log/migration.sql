-- CreateEnum
CREATE TYPE "EmailLogAction" AS ENUM ('CREATED_TICKET', 'APPENDED_REPLY', 'SKIPPED_DUPLICATE', 'SKIPPED_LOOP', 'FAILED');

-- CreateTable
CREATE TABLE "EmailProcessingLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "messageId" TEXT,
    "fromEmail" TEXT,
    "subject" TEXT,
    "action" "EmailLogAction" NOT NULL,
    "ticketId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailProcessingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailPollRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "created" INTEGER NOT NULL DEFAULT 0,
    "appended" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "succeeded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EmailPollRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailProcessingLog_runId_idx" ON "EmailProcessingLog"("runId");

-- CreateIndex
CREATE INDEX "EmailProcessingLog_createdAt_idx" ON "EmailProcessingLog"("createdAt");

-- CreateIndex
CREATE INDEX "EmailProcessingLog_action_idx" ON "EmailProcessingLog"("action");

-- CreateIndex
CREATE INDEX "EmailPollRun_startedAt_idx" ON "EmailPollRun"("startedAt");
