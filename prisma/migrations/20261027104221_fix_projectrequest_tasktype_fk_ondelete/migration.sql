-- Pre-existing drift fix, unrelated to SQLGeneral: schema.prisma's
-- ProjectRequest.projectType relation has no explicit onDelete, and
-- Prisma's documented default for an optional scalar relation field is
-- SetNull — this recreates the FK to match (corrective only, no data
-- change). Split into its own migration so the SQLGeneral migration
-- contains only SQLGeneral changes.
-- DropForeignKey
ALTER TABLE "ProjectRequest" DROP CONSTRAINT "ProjectRequest_projectTypeId_fkey";

-- AlterTable
ALTER TABLE "ProjectFeedback" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_projectTypeId_fkey" FOREIGN KEY ("projectTypeId") REFERENCES "TaskType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
