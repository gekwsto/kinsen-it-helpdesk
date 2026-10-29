-- CreateEnum
CREATE TYPE "IntermediateApprovalSkipReason" AS ENUM ('NO_MANAGER', 'PERMISSION_BYPASS');

-- AlterTable
ALTER TABLE "ProjectRequest" ADD COLUMN     "intermediateApprovalSkipReason" "IntermediateApprovalSkipReason";
