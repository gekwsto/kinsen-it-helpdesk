-- Remove title and description from YearlyGoal
ALTER TABLE "YearlyGoal" DROP COLUMN IF EXISTS "title";
ALTER TABLE "YearlyGoal" DROP COLUMN IF EXISTS "description";

-- Add isGoal to Project
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "isGoal" BOOLEAN NOT NULL DEFAULT false;

-- Create ActivityAssignees implicit many-to-many join table
CREATE TABLE IF NOT EXISTS "_ActivityAssignees" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "_ActivityAssignees_AB_unique" ON "_ActivityAssignees"("A", "B");
CREATE INDEX IF NOT EXISTS "_ActivityAssignees_B_index" ON "_ActivityAssignees"("B");

ALTER TABLE "_ActivityAssignees" DROP CONSTRAINT IF EXISTS "_ActivityAssignees_A_fkey";
ALTER TABLE "_ActivityAssignees" ADD CONSTRAINT "_ActivityAssignees_A_fkey"
  FOREIGN KEY ("A") REFERENCES "ProjectActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_ActivityAssignees" DROP CONSTRAINT IF EXISTS "_ActivityAssignees_B_fkey";
ALTER TABLE "_ActivityAssignees" ADD CONSTRAINT "_ActivityAssignees_B_fkey"
  FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing assignedUserId data to ActivityAssignees (admin users only)
INSERT INTO "_ActivityAssignees" ("A", "B")
SELECT pa.id, pa."assignedUserId"
FROM "ProjectActivity" pa
INNER JOIN "User" u ON u.id = pa."assignedUserId" AND u.role = 'ADMIN'
WHERE pa."assignedUserId" IS NOT NULL
ON CONFLICT DO NOTHING;
