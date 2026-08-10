-- DropIndex
DROP INDEX "Department_companyId_idx";

-- CreateIndex
CREATE INDEX "Project_createdAt_idx" ON "Project"("createdAt");

-- CreateIndex
CREATE INDEX "ProjectActivity_createdAt_idx" ON "ProjectActivity"("createdAt");

-- RenameIndex
ALTER INDEX "MicrosoftDepartmentMapping_sourceType_domain_normalizedMicrosof" RENAME TO "MicrosoftDepartmentMapping_sourceType_domain_normalizedMicr_key";
