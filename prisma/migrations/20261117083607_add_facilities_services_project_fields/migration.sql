-- CreateEnum
CREATE TYPE "ProjectDatePrecision" AS ENUM ('EXACT', 'QUARTER');

-- CreateEnum
CREATE TYPE "ProjectQuarter" AS ENUM ('Q1', 'Q2', 'Q3', 'Q4');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "facilitiesCompany" TEXT,
ADD COLUMN     "facilitiesEndPrecision" "ProjectDatePrecision",
ADD COLUMN     "facilitiesEndQuarter" "ProjectQuarter",
ADD COLUMN     "facilitiesEndYear" INTEGER,
ADD COLUMN     "facilitiesLocation" TEXT,
ADD COLUMN     "facilitiesStartPrecision" "ProjectDatePrecision",
ADD COLUMN     "facilitiesStartQuarter" "ProjectQuarter",
ADD COLUMN     "facilitiesStartYear" INTEGER;
