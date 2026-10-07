-- CreateTable
CREATE TABLE "_ProjectOwners" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProjectOwners_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ProjectAudience" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProjectAudience_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_ProjectOwners_B_index" ON "_ProjectOwners"("B");

-- CreateIndex
CREATE INDEX "_ProjectAudience_B_index" ON "_ProjectAudience"("B");

-- AddForeignKey
ALTER TABLE "_ProjectOwners" ADD CONSTRAINT "_ProjectOwners_A_fkey" FOREIGN KEY ("A") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectOwners" ADD CONSTRAINT "_ProjectOwners_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectAudience" ADD CONSTRAINT "_ProjectAudience_A_fkey" FOREIGN KEY ("A") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProjectAudience" ADD CONSTRAINT "_ProjectAudience_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every EXISTING Project (manual or request-origin, created
-- before this migration) gets its own single ownerId mirrored into the new
-- _ProjectOwners join table — this is what keeps "owners always contains
-- ownerId" a universal invariant for every Project, not just ones created
-- after this migration (see Project.owners' own schema doc comment). A
-- request-origin Project created AFTER this migration gets its real,
-- explicitly-selected multi-owner set instead, written by
-- createProjectFromApprovedRequest at creation time, not by this backfill.
INSERT INTO "_ProjectOwners" ("A", "B")
SELECT "id", "ownerId" FROM "Project"
ON CONFLICT DO NOTHING;
