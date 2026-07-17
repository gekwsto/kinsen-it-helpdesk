-- Adds PROFILE_JOB_TITLE (MicrosoftMappingSourceType) and MICROSOFT_JOB_TITLE
-- (MembershipSource) enum values, plus the MicrosoftDirectoryJobTitleValue
-- cache table (same shape as MicrosoftDirectoryDepartmentValue). Additive
-- only — no existing data touched, no existing enum values removed. Safe in
-- one transaction: the new enum values aren't referenced by any DML in this
-- same file.

ALTER TYPE "MicrosoftMappingSourceType" ADD VALUE 'PROFILE_JOB_TITLE';
ALTER TYPE "MembershipSource" ADD VALUE 'MICROSOFT_JOB_TITLE';

CREATE TABLE "MicrosoftDirectoryJobTitleValue" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftDirectoryJobTitleValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MicrosoftDirectoryJobTitleValue_value_key" ON "MicrosoftDirectoryJobTitleValue"("value");
