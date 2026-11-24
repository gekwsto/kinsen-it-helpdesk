-- CreateEnum
CREATE TYPE "ProjectRequestSource" AS ENUM ('STANDARD', 'HISTORICAL_IMPORT');

-- DropForeignKey
ALTER TABLE "ProjectRequest" DROP CONSTRAINT "ProjectRequest_requesterId_fkey";

-- AlterTable
ALTER TABLE "ProjectRequest" ADD COLUMN     "externalSourceId" TEXT,
ADD COLUMN     "source" "ProjectRequestSource" NOT NULL DEFAULT 'STANDARD',
ALTER COLUMN "requesterId" DROP NOT NULL,
ALTER COLUMN "submittedAt" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRequest_externalSourceId_key" ON "ProjectRequest"("externalSourceId");

-- CreateIndex
CREATE INDEX "ProjectRequest_source_idx" ON "ProjectRequest"("source");

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
