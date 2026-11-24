-- AlterTable
ALTER TABLE "ProjectRequest" ADD COLUMN     "historicalSourceMetadata" JSONB,
ALTER COLUMN "description" DROP NOT NULL,
ALTER COLUMN "importance" DROP NOT NULL,
ALTER COLUMN "teamConcerned" DROP NOT NULL,
ALTER COLUMN "expectedBenefits" DROP NOT NULL;
