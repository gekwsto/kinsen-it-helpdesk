-- AlterTable
ALTER TABLE "MicrosoftDepartmentMapping" ADD COLUMN     "departmentCustomRoleId" TEXT,
ADD COLUMN     "globalCustomRoleId" TEXT;

-- CreateIndex
CREATE INDEX "MicrosoftDepartmentMapping_globalCustomRoleId_idx" ON "MicrosoftDepartmentMapping"("globalCustomRoleId");

-- CreateIndex
CREATE INDEX "MicrosoftDepartmentMapping_departmentCustomRoleId_idx" ON "MicrosoftDepartmentMapping"("departmentCustomRoleId");

-- AddForeignKey
ALTER TABLE "MicrosoftDepartmentMapping" ADD CONSTRAINT "MicrosoftDepartmentMapping_globalCustomRoleId_fkey" FOREIGN KEY ("globalCustomRoleId") REFERENCES "CustomRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MicrosoftDepartmentMapping" ADD CONSTRAINT "MicrosoftDepartmentMapping_departmentCustomRoleId_fkey" FOREIGN KEY ("departmentCustomRoleId") REFERENCES "CustomRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
