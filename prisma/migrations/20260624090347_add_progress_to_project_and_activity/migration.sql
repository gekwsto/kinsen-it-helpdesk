-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ProjectActivity" ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;
