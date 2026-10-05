-- Adds ProjectFeedback — the ORIGINAL Project Request requester's one-time
-- evaluation of a delivered, request-origin Project (satisfaction 1-10 +
-- optional free-text comments). Purely additive: no existing table/column
-- is touched, no backfill needed (Project/ProjectRequest rows that predate
-- this feature simply never get a feedback row).
--
-- Both `projectId` and `projectRequestId` are UNIQUE — at most one feedback
-- row per Project (the structural invariant this feature's own
-- authorization route relies on instead of UI hiding alone) AND, since a
-- Project Request has at most one Project (Project.projectRequestId is
-- itself @unique), at most one feedback row per Project Request too.
--
-- The trailing RenameIndex below is an unrelated, pre-existing cosmetic
-- drift between this schema and the DB's already-applied index name for
-- ProjectRequestIntermediateApprover (a metadata-only rename, zero data
-- loss, picked up automatically by `prisma migrate dev`'s diff) — not part
-- of this feature.

-- CreateTable
CREATE TABLE "ProjectFeedback" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectRequestId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "satisfactionScore" INTEGER NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectFeedback_projectId_key" ON "ProjectFeedback"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectFeedback_projectRequestId_key" ON "ProjectFeedback"("projectRequestId");

-- CreateIndex
CREATE INDEX "ProjectFeedback_submittedByUserId_idx" ON "ProjectFeedback"("submittedByUserId");

-- AddForeignKey
ALTER TABLE "ProjectFeedback" ADD CONSTRAINT "ProjectFeedback_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFeedback" ADD CONSTRAINT "ProjectFeedback_projectRequestId_fkey" FOREIGN KEY ("projectRequestId") REFERENCES "ProjectRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectFeedback" ADD CONSTRAINT "ProjectFeedback_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ProjectRequestIntermediateApprover_projectRequestId_approv_key" RENAME TO "ProjectRequestIntermediateApprover_projectRequestId_approve_key";
