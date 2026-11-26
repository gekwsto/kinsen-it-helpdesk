-- Persistent Project Feedback obligations (approved).
--
-- Additive only: no existing row is modified or deleted, and there is NO
-- backfill. Existing Projects get feedbackRequestedAt = NULL ("not tracked":
-- completed before Feedback tracking existed) and no ProjectFeedbackRequest
-- rows, so historical Projects acquire no pending obligations and nobody is
-- notified retroactively. Obligations are created only by a future
-- non-COMPLETED -> COMPLETED transition (lib/services/project-feedback-service.ts).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "feedbackRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ProjectFeedbackRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectFeedbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectFeedbackRequest_userId_idx" ON "ProjectFeedbackRequest"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectFeedbackRequest_projectId_userId_key" ON "ProjectFeedbackRequest"("projectId", "userId");

-- AddForeignKey
ALTER TABLE "ProjectFeedbackRequest" ADD CONSTRAINT "ProjectFeedbackRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFeedbackRequest" ADD CONSTRAINT "ProjectFeedbackRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

