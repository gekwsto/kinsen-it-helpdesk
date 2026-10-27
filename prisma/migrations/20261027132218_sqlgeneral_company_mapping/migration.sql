-- CreateTable
CREATE TABLE "SqlGeneralCompanyMapping" (
    "id" TEXT NOT NULL,
    "sqlGeneralCompanyId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SqlGeneralCompanyMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SqlGeneralCompanyMapping_sqlGeneralCompanyId_key" ON "SqlGeneralCompanyMapping"("sqlGeneralCompanyId");

-- CreateIndex
CREATE INDEX "SqlGeneralCompanyMapping_companyId_idx" ON "SqlGeneralCompanyMapping"("companyId");

-- AddForeignKey
ALTER TABLE "SqlGeneralCompanyMapping" ADD CONSTRAINT "SqlGeneralCompanyMapping_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SqlGeneralCompanyMapping" ADD CONSTRAINT "SqlGeneralCompanyMapping_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
