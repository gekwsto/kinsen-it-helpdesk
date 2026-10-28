-- CreateTable
CREATE TABLE "SqlGeneralDepartmentMapping" (
    "id" TEXT NOT NULL,
    "sqlGeneralDepartmentId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SqlGeneralDepartmentMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SqlGeneralDepartmentMapping_sqlGeneralDepartmentId_key" ON "SqlGeneralDepartmentMapping"("sqlGeneralDepartmentId");

-- CreateIndex
CREATE INDEX "SqlGeneralDepartmentMapping_departmentId_idx" ON "SqlGeneralDepartmentMapping"("departmentId");

-- AddForeignKey
ALTER TABLE "SqlGeneralDepartmentMapping" ADD CONSTRAINT "SqlGeneralDepartmentMapping_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SqlGeneralDepartmentMapping" ADD CONSTRAINT "SqlGeneralDepartmentMapping_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
