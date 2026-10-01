-- Adds the requester-selected, unanimous, multi-approver "intermediate"
-- approval stage ahead of the pre-existing single final approval stage.
--
-- Fully additive and safe for the existing ProjectRequest rows already in
-- this database:
--   - The new IntermediateApprovalStatus enum and
--     ProjectRequestIntermediateApprover table are brand new — nothing
--     references them yet.
--   - ProjectRequest.status's DEFAULT changes to the new
--     PENDING_INTERMEDIATE_APPROVAL value (added in the prior migration) —
--     this ONLY affects rows inserted from now on. No existing row's
--     `status` column is touched by this migration; a pre-existing row
--     sitting at PENDING_APPROVAL/APPROVED/REJECTED stays exactly there,
--     with zero ProjectRequestIntermediateApprover rows, and therefore
--     skips the intermediate stage entirely for its own (already in-
--     flight or already-decided) lifecycle — never retroactively reopened
--     or fabricated.

-- CreateEnum
CREATE TYPE "IntermediateApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ProjectRequestIntermediateApprover" (
    "id" TEXT NOT NULL,
    "projectRequestId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "status" "IntermediateApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "businessAssessment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRequestIntermediateApprover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRequestIntermediateApprover_projectRequestId_approv_key" ON "ProjectRequestIntermediateApprover"("projectRequestId", "approverId");

-- CreateIndex
CREATE INDEX "ProjectRequestIntermediateApprover_projectRequestId_idx" ON "ProjectRequestIntermediateApprover"("projectRequestId");

-- CreateIndex
CREATE INDEX "ProjectRequestIntermediateApprover_approverId_idx" ON "ProjectRequestIntermediateApprover"("approverId");

-- AddForeignKey
ALTER TABLE "ProjectRequestIntermediateApprover" ADD CONSTRAINT "ProjectRequestIntermediateApprover_projectRequestId_fkey" FOREIGN KEY ("projectRequestId") REFERENCES "ProjectRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequestIntermediateApprover" ADD CONSTRAINT "ProjectRequestIntermediateApprover_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: only the DEFAULT changes — no existing row is updated.
ALTER TABLE "ProjectRequest" ALTER COLUMN "status" SET DEFAULT 'PENDING_INTERMEDIATE_APPROVAL';
