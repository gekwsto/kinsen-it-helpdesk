-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "facilitiesIsBigProject" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "facilitiesPlannedForAnnualTargets" BOOLEAN NOT NULL DEFAULT false;
