-- Adds User.lastMicrosoftSyncAt (nullable, additive) and the
-- MicrosoftDirectoryDepartmentValue cache table used by the admin Microsoft
-- Value dropdown. No backfill needed — both are new/nullable.

ALTER TABLE "User" ADD COLUMN "lastMicrosoftSyncAt" TIMESTAMP(3);

CREATE TABLE "MicrosoftDirectoryDepartmentValue" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MicrosoftDirectoryDepartmentValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MicrosoftDirectoryDepartmentValue_value_key" ON "MicrosoftDirectoryDepartmentValue"("value");
