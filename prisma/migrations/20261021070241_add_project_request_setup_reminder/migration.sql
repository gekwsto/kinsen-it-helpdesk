-- Delayed reminder for an APPROVED Project Request that still has no
-- Project set up — see lib/services/project-request-setup-reminder-service.ts.
-- Same durable-queue shape as MentionReminder (PENDING/PROCESSING/SENT/
-- CANCELLED, atomic claim via claimToken), but one row notifies EVERY
-- currently-eligible approver for the department, not a single fixed
-- recipient — see the model's own doc comment in schema.prisma.

-- CreateEnum
CREATE TYPE "ProjectRequestSetupReminderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'CANCELLED');

-- CreateTable
CREATE TABLE "ProjectRequestSetupReminder" (
    "id" TEXT NOT NULL,
    "projectRequestId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "ProjectRequestSetupReminderStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRequestSetupReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRequestSetupReminder_projectRequestId_key" ON "ProjectRequestSetupReminder"("projectRequestId");
CREATE INDEX "ProjectRequestSetupReminder_status_dueAt_idx" ON "ProjectRequestSetupReminder"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "ProjectRequestSetupReminder" ADD CONSTRAINT "ProjectRequestSetupReminder_projectRequestId_fkey" FOREIGN KEY ("projectRequestId") REFERENCES "ProjectRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
