-- Project Parent: global, optional organizational grouping of Projects
-- (lib/services/project-parent-service.ts).
--
-- * New table only + one nullable column on "Project" (no default, no
--   backfill): every existing Project stays unlinked and no existing value
--   changes.
-- * Case-insensitive, trimmed UNIQUE names enforced by the database (also
--   under concurrent creation): "normalizedName" is UNIQUE and CHECK
--   constraints pin it to lower(btrim("name")), with "name" itself stored
--   trimmed and non-empty.
-- * Project.parentId -> ProjectParent ON DELETE RESTRICT: a Parent with
--   linked Projects can never be deleted, and deleting a Parent never
--   touches Projects.

CREATE TABLE "ProjectParent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectParent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProjectParent_name_trimmed_nonempty" CHECK ("name" = btrim("name") AND length("name") > 0),
    CONSTRAINT "ProjectParent_normalizedName_matches" CHECK ("normalizedName" = lower(btrim("name")))
);

CREATE UNIQUE INDEX "ProjectParent_normalizedName_key" ON "ProjectParent"("normalizedName");

ALTER TABLE "Project" ADD COLUMN "parentId" TEXT;

CREATE INDEX "Project_parentId_idx" ON "Project"("parentId");

ALTER TABLE "Project" ADD CONSTRAINT "Project_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "ProjectParent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
