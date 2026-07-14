-- Phase 1 of the multi-department/workspace architecture.
-- Everything here is additive: no column is dropped, no existing FK is
-- changed, and no departmentId column becomes NOT NULL at the DB level.
-- "Required going forward" is enforced in the Zod/API layer (Phase 2), not
-- by a database constraint, so existing rows with NULL departmentId keep
-- working unchanged until backfill.sql (run separately) assigns them.
--
-- This file was authored by hand against this repo's existing migration
-- conventions (see 20260706130000_add_activity_dependencies for the same
-- enum/table/index/FK style) because no live database was reachable to
-- generate it via `prisma migrate dev`'s shadow-database diff. Review this
-- file carefully — ideally run it against a staging copy first — before
-- `prisma migrate deploy` in any real environment. See README.md in this
-- folder for the full run procedure.

-- CreateEnum
CREATE TYPE "DepartmentRole" AS ENUM ('DEPARTMENT_ADMIN', 'DEPARTMENT_MANAGER', 'PROJECT_MANAGER', 'AGENT_ASSIGNEE', 'REQUESTER', 'VIEWER');

-- CreateEnum
CREATE TYPE "MembershipSource" AS ENUM ('MICROSOFT_DEPARTMENT', 'MICROSOFT_GROUP', 'MICROSOFT_APP_ROLE', 'MANUAL');

-- CreateEnum
CREATE TYPE "MicrosoftMappingSourceType" AS ENUM ('PROFILE_DEPARTMENT', 'ENTRA_GROUP', 'ENTRA_APP_ROLE');

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Backfill slug for any existing Department rows before enforcing NOT NULL +
-- UNIQUE below. Generic slugify (lowercase, non-alphanumeric runs -> "-",
-- trim leading/trailing "-") so this is safe regardless of what departments
-- already exist at run time, not just the 5 known seed rows.
UPDATE "Department"
SET "slug" = trim(BOTH '-' FROM lower(regexp_replace(trim("name"), '[^a-zA-Z0-9]+', '-', 'g')))
WHERE "slug" IS NULL;

-- Disambiguate any collisions the generic slugify above could produce (e.g.
-- two departments both named "IT" in different business units) by appending
-- a short suffix from the row id.
UPDATE "Department" d
SET "slug" = d."slug" || '-' || substr(d."id", 1, 6)
WHERE d."slug" IN (
  SELECT "slug" FROM "Department" GROUP BY "slug" HAVING COUNT(*) > 1
);

ALTER TABLE "Department" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Department_slug_key" ON "Department"("slug");

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "microsoftUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_microsoftUserId_key" ON "User"("microsoftUserId");

-- AlterTable
ALTER TABLE "TicketCategory" ADD COLUMN     "departmentId" TEXT;

-- DropIndex
DROP INDEX "TicketCategory_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "TicketCategory_departmentId_name_key" ON "TicketCategory"("departmentId", "name");

-- AddForeignKey
ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Project_departmentId_idx" ON "Project"("departmentId");

-- CreateIndex
CREATE INDEX "ProjectActivity_departmentId_idx" ON "ProjectActivity"("departmentId");

-- CreateTable
CREATE TABLE "DepartmentMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "role" "DepartmentRole" NOT NULL,
    "source" "MembershipSource" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepartmentMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepartmentMembership_departmentId_idx" ON "DepartmentMembership"("departmentId");

-- CreateIndex
CREATE INDEX "DepartmentMembership_userId_idx" ON "DepartmentMembership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentMembership_userId_departmentId_key" ON "DepartmentMembership"("userId", "departmentId");

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "MicrosoftDepartmentMapping" (
    "id" TEXT NOT NULL,
    "sourceType" "MicrosoftMappingSourceType" NOT NULL,
    "microsoftValue" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "role" "DepartmentRole" NOT NULL DEFAULT 'REQUESTER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftDepartmentMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MicrosoftDepartmentMapping_departmentId_idx" ON "MicrosoftDepartmentMapping"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "MicrosoftDepartmentMapping_sourceType_microsoftValue_key" ON "MicrosoftDepartmentMapping"("sourceType", "microsoftValue");

-- AddForeignKey
ALTER TABLE "MicrosoftDepartmentMapping" ADD CONSTRAINT "MicrosoftDepartmentMapping_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
