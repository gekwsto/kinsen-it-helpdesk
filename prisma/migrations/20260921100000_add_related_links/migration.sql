-- CreateTable
CREATE TABLE "RelatedLink" (
    "id" TEXT NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "title" VARCHAR(250) NOT NULL,
    "projectId" TEXT,
    "activityId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelatedLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RelatedLink_projectId_createdAt_idx" ON "RelatedLink"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "RelatedLink_activityId_createdAt_idx" ON "RelatedLink"("activityId", "createdAt");

-- CreateIndex
CREATE INDEX "RelatedLink_createdById_idx" ON "RelatedLink"("createdById");

-- AddForeignKey
ALTER TABLE "RelatedLink" ADD CONSTRAINT "RelatedLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedLink" ADD CONSTRAINT "RelatedLink_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ProjectActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelatedLink" ADD CONSTRAINT "RelatedLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Exactly ONE owner: a link belongs to a Project XOR an Activity — never both,
-- never neither. Prisma's schema language cannot express CHECK constraints, so
-- this lives only in SQL (hand-maintained; `prisma migrate dev` ignores it).
ALTER TABLE "RelatedLink" ADD CONSTRAINT "RelatedLink_exactly_one_owner_chk"
    CHECK (("projectId" IS NOT NULL AND "activityId" IS NULL) OR ("projectId" IS NULL AND "activityId" IS NOT NULL));
