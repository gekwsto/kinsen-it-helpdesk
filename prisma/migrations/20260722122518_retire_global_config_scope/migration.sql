/*
  Warnings:

  - Made the column `departmentId` on table `TicketCategory` required. This step will fail if there are existing NULL values in that column.
  - Made the column `departmentId` on table `TicketPriority` required. This step will fail if there are existing NULL values in that column.
  - Made the column `departmentId` on table `TicketStatus` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "TicketCategory" DROP CONSTRAINT "TicketCategory_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "TicketPriority" DROP CONSTRAINT "TicketPriority_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "TicketStatus" DROP CONSTRAINT "TicketStatus_departmentId_fkey";

-- AlterTable
ALTER TABLE "TicketCategory" ALTER COLUMN "departmentId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TicketPriority" ALTER COLUMN "departmentId" SET NOT NULL;

-- AlterTable
ALTER TABLE "TicketStatus" ALTER COLUMN "departmentId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketPriority" ADD CONSTRAINT "TicketPriority_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketStatus" ADD CONSTRAINT "TicketStatus_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
