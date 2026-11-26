-- AlterEnum
ALTER TYPE "IntermediateApprovalSkipReason" ADD VALUE 'REQUESTER_OPTED_OUT';

-- AlterTable
ALTER TABLE "ProjectRequest" ADD COLUMN     "finalApprovalSkipped" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "finalApprovalSkippedAt" TIMESTAMP(3),
ADD COLUMN     "finalApprovalSkippedById" TEXT;

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_finalApprovalSkippedById_fkey" FOREIGN KEY ("finalApprovalSkippedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New permission: Skip Final Approval (Project Requests). Registered only —
-- deliberately NOT granted to any role (administrators assign it explicitly
-- through role permission management; Global and Department scopes).
INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'projectRequest.skipFinalApproval', 'Skip Final Approval — Allows users to bypass the final approval stage when creating a Project Request.', 'projectRequests', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- projectRequest.skipIntermediateApproval is retired: every requester may now
-- opt out of Intermediate Approval at submission, so the permission is no
-- longer enforced. The row and any existing role grants are kept untouched
-- (non-destructive); only its description is updated so administrators see
-- that it has no effect. Historical PERMISSION_BYPASS records are unchanged.
UPDATE "Permission"
SET "description" = 'Retired — no longer enforced. Every requester can now choose to skip Intermediate Approval when submitting a Project Request.', "updatedAt" = now()
WHERE "key" = 'projectRequest.skipIntermediateApproval';
