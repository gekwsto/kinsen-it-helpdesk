-- Redesigns the Project Request approval workflow from a two-stage
-- (requester's org-chart manager -> department-scoped system approver)
-- flow into a SINGLE department-scoped approval stage: any user holding
-- effective `projectRequest.approve` for the request's own department
-- (global grant, or that department's own grant) may approve or reject —
-- never tied to the requester's Microsoft-synced manager relation at all.
--
-- Confirmed against the target database before writing this: zero
-- ProjectRequest rows existed at the time of this migration (the feature
-- was still in active design/testing, never reached real usage), so the
-- destructive column drops below are safe. The status-enum collapse still
-- includes an explicit UPDATE mapping for defensiveness, in case this ever
-- runs against a database that does have rows in one of the old pending
-- states.

-- Drop the manager-approval stage: its FK, index, and columns.
ALTER TABLE "ProjectRequest" DROP CONSTRAINT "ProjectRequest_managerApproverId_fkey";
DROP INDEX "ProjectRequest_managerApproverId_idx";
ALTER TABLE "ProjectRequest" DROP COLUMN "managerApproverId";
ALTER TABLE "ProjectRequest" DROP COLUMN "managerApprovedAt";
ALTER TABLE "ProjectRequest" DROP COLUMN "managerRejectedAt";
ALTER TABLE "ProjectRequest" DROP COLUMN "managerComment";

-- The former "system" approval columns are now the ONLY approval stage, so
-- the "system" qualifier no longer applies — renamed (not dropped/recreated)
-- to preserve any existing data and the underlying column identity.
ALTER TABLE "ProjectRequest" RENAME COLUMN "systemApproverId" TO "approverId";
ALTER TABLE "ProjectRequest" RENAME COLUMN "systemApprovedAt" TO "approvedAt";
ALTER TABLE "ProjectRequest" RENAME COLUMN "systemRejectedAt" TO "rejectedAt";
ALTER TABLE "ProjectRequest" RENAME COLUMN "systemComment" TO "comment";
ALTER TABLE "ProjectRequest" RENAME CONSTRAINT "ProjectRequest_systemApproverId_fkey" TO "ProjectRequest_approverId_fkey";
ALTER INDEX "ProjectRequest_systemApproverId_idx" RENAME TO "ProjectRequest_approverId_idx";

-- Collapse the two pending states into a single PENDING_APPROVAL. Any row
-- in either old pending state becomes PENDING_APPROVAL — the only
-- meaningful mapping, since the manager stage the two pending states used
-- to distinguish no longer exists. APPROVED/REJECTED rows are unaffected.
ALTER TABLE "ProjectRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ProjectRequest" ALTER COLUMN "status" TYPE TEXT USING ("status"::TEXT);
UPDATE "ProjectRequest" SET "status" = 'PENDING_APPROVAL' WHERE "status" IN ('PENDING_MANAGER_APPROVAL', 'PENDING_SYSTEM_APPROVAL');
DROP TYPE "ProjectRequestStatus";
CREATE TYPE "ProjectRequestStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED');
ALTER TABLE "ProjectRequest" ALTER COLUMN "status" TYPE "ProjectRequestStatus" USING ("status"::"ProjectRequestStatus");
ALTER TABLE "ProjectRequest" ALTER COLUMN "status" SET DEFAULT 'PENDING_APPROVAL';
