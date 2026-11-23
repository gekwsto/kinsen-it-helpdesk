-- AlterTable
ALTER TABLE "ProjectRequest" ADD COLUMN     "requesterDepartmentId" TEXT;

-- CreateIndex
CREATE INDEX "ProjectRequest_requesterDepartmentId_idx" ON "ProjectRequest"("requesterDepartmentId");

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_requesterDepartmentId_fkey" FOREIGN KEY ("requesterDepartmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
