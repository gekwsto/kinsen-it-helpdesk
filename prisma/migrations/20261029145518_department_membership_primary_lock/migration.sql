-- AlterTable
ALTER TABLE "DepartmentMembership" ADD COLUMN     "primaryLockedAt" TIMESTAMP(3),
ADD COLUMN     "primaryLockedById" TEXT;
