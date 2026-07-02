-- AlterTable
ALTER TABLE "_ActivityAssignees" ADD CONSTRAINT "_ActivityAssignees_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "_ActivityAssignees_AB_unique";
