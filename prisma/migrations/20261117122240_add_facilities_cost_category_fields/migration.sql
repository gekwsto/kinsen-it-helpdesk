-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "facilitiesActualCost" DECIMAL(10,2),
ADD COLUMN     "facilitiesActualCostNotes" TEXT,
ADD COLUMN     "facilitiesCategory" TEXT,
ADD COLUMN     "facilitiesEstimatedCost" DECIMAL(10,2),
ADD COLUMN     "facilitiesEstimatedCostNotes" TEXT;
