-- CreateTable
CREATE TABLE "_ProjectResponsiblePeople" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProjectResponsiblePeople_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_ProjectResponsiblePeople_B_index" ON "_ProjectResponsiblePeople"("B");

-- AddForeignKey
ALTER TABLE "_ProjectResponsiblePeople" ADD CONSTRAINT "_ProjectResponsiblePeople_A_fkey" FOREIGN KEY ("A") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectResponsiblePeople" ADD CONSTRAINT "_ProjectResponsiblePeople_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
