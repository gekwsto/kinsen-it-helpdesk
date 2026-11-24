-- CreateTable
CREATE TABLE "_ProjectAudienceBusinessUnits" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProjectAudienceBusinessUnits_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ProjectAudienceDepartments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProjectAudienceDepartments_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_ProjectAudienceBusinessUnits_B_index" ON "_ProjectAudienceBusinessUnits"("B");

-- CreateIndex
CREATE INDEX "_ProjectAudienceDepartments_B_index" ON "_ProjectAudienceDepartments"("B");

-- AddForeignKey
ALTER TABLE "_ProjectAudienceBusinessUnits" ADD CONSTRAINT "_ProjectAudienceBusinessUnits_A_fkey" FOREIGN KEY ("A") REFERENCES "BusinessUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectAudienceBusinessUnits" ADD CONSTRAINT "_ProjectAudienceBusinessUnits_B_fkey" FOREIGN KEY ("B") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectAudienceDepartments" ADD CONSTRAINT "_ProjectAudienceDepartments_A_fkey" FOREIGN KEY ("A") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectAudienceDepartments" ADD CONSTRAINT "_ProjectAudienceDepartments_B_fkey" FOREIGN KEY ("B") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
