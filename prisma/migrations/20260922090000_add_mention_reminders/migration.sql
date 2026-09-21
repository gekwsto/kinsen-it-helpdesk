-- CreateEnum
CREATE TYPE "MentionReminderStatus" AS ENUM ('PENDING', 'PROCESSING', 'RESPONDED', 'SENT', 'CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "mentionRemindersEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "MentionReminder" (
    "id" TEXT NOT NULL,
    "projectNoteMentionId" TEXT,
    "activityNoteMentionId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "MentionReminderStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentionReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentionReminderSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "delayMinutes" INTEGER NOT NULL DEFAULT 1440,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "MentionReminderSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MentionReminder_projectNoteMentionId_key" ON "MentionReminder"("projectNoteMentionId");
CREATE UNIQUE INDEX "MentionReminder_activityNoteMentionId_key" ON "MentionReminder"("activityNoteMentionId");
CREATE INDEX "MentionReminder_status_dueAt_idx" ON "MentionReminder"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "MentionReminder" ADD CONSTRAINT "MentionReminder_projectNoteMentionId_fkey" FOREIGN KEY ("projectNoteMentionId") REFERENCES "ProjectNoteMention"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MentionReminder" ADD CONSTRAINT "MentionReminder_activityNoteMentionId_fkey" FOREIGN KEY ("activityNoteMentionId") REFERENCES "ActivityNoteMention"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one source: a Project Note mention XOR an Activity Note mention.
ALTER TABLE "MentionReminder" ADD CONSTRAINT "MentionReminder_exactly_one_source_chk"
  CHECK (("projectNoteMentionId" IS NOT NULL AND "activityNoteMentionId" IS NULL)
      OR ("projectNoteMentionId" IS NULL AND "activityNoteMentionId" IS NOT NULL));

-- Safe bounds for the admin-configured delay (minutes): 5 minutes .. 30 days.
ALTER TABLE "MentionReminderSettings" ADD CONSTRAINT "MentionReminderSettings_delay_bounds_chk"
  CHECK ("delayMinutes" BETWEEN 5 AND 43200);
