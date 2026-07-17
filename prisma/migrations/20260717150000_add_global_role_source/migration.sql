-- Adds GlobalRoleSource enum and User.globalRoleSource/globalRoleUpdatedAt/
-- globalRoleMicrosoftMappingId (all nullable/defaulted, additive). No
-- backfill needed — every existing row gets 'SYSTEM' automatically via the
-- column default, which keeps them eligible for the new Microsoft global-
-- role sync until an admin or a login explicitly sets a different source.

CREATE TYPE "GlobalRoleSource" AS ENUM ('SYSTEM', 'MANUAL', 'MICROSOFT_DEPARTMENT');

ALTER TABLE "User" ADD COLUMN "globalRoleSource" "GlobalRoleSource" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "User" ADD COLUMN "globalRoleUpdatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "globalRoleMicrosoftMappingId" TEXT;

ALTER TABLE "User"
  ADD CONSTRAINT "User_globalRoleMicrosoftMappingId_fkey"
  FOREIGN KEY ("globalRoleMicrosoftMappingId") REFERENCES "MicrosoftDepartmentMapping"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
