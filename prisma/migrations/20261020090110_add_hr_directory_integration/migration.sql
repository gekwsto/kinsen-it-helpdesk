-- Introduces the external HR directory API (lib/services/hr-directory-sync-service.ts)
-- as an organization-data source alongside Microsoft Graph. All three new
-- columns are nullable and uniquely-indexed external-id/match-key columns —
-- every existing row simply has NULL until the HR sync runs once; Postgres
-- allows any number of NULLs in a unique index, so this is safe against
-- current data regardless of row count.

-- MembershipSource: new provenance value for a primary placement sourced
-- from the HR API rather than Microsoft Graph (MICROSOFT_DEPARTMENT).
ALTER TYPE "MembershipSource" ADD VALUE 'HR_DIRECTORY';

-- Company/Department: the HR API's own stable integer ids — checked FIRST
-- on every HR sync before falling back to the existing normalizedName
-- string-match path, so a rename in the HR system never creates a
-- duplicate root.
ALTER TABLE "Company" ADD COLUMN "hrCompanyId" INTEGER;
CREATE UNIQUE INDEX "Company_hrCompanyId_key" ON "Company"("hrCompanyId");

ALTER TABLE "Department" ADD COLUMN "hrDepartmentId" INTEGER;
CREATE UNIQUE INDEX "Department_hrDepartmentId_key" ON "Department"("hrDepartmentId");

-- User: the HR API's Username/sAMAccountName — a stable match key checked
-- before falling back to email, since a user's AD username and their email
-- local-part are not guaranteed to match (confirmed in the HR API's own
-- sample data).
ALTER TABLE "User" ADD COLUMN "hrUsername" TEXT;
CREATE UNIQUE INDEX "User_hrUsername_key" ON "User"("hrUsername");
