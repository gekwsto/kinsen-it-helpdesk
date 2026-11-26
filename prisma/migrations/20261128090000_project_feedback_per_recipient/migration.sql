-- Project Feedback per recipient (approved): one row per (Project, recipient)
-- instead of one row per Project. Recipients = the Project's Responsible
-- People when it has any, otherwise its primary Owner (resolved in
-- lib/services/project-feedback-service.ts). Request-origin only (unchanged):
-- projectRequestId stays NOT NULL.
--
-- Data-preserving: no row is modified or deleted. Every existing Project has
-- at most one ProjectFeedback row (the old @unique(projectId)), so the new
-- composite unique key is satisfied by existing data as-is.

-- DropIndex
DROP INDEX "ProjectFeedback_projectId_key";

-- DropIndex
DROP INDEX "ProjectFeedback_projectRequestId_key";

-- CreateIndex
CREATE INDEX "ProjectFeedback_projectId_idx" ON "ProjectFeedback"("projectId");

-- CreateIndex
CREATE INDEX "ProjectFeedback_projectRequestId_idx" ON "ProjectFeedback"("projectRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectFeedback_projectId_submittedByUserId_key" ON "ProjectFeedback"("projectId", "submittedByUserId");
