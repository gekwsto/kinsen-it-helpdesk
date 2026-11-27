-- Configurable Project Status definitions (approved).
--
-- Data-preserving: Project.status (the canonical lifecycle state) is NOT
-- modified for any row. Every existing Project is linked to the SYSTEM
-- definition of its current canonical status.

-- CreateTable
CREATE TABLE "ProjectStatusDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#94a3b8',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "canonicalStatus" "ProjectStatus" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectStatusDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectStatusDefinition_key_key" ON "ProjectStatusDefinition"("key");
CREATE INDEX "ProjectStatusDefinition_canonicalStatus_idx" ON "ProjectStatusDefinition"("canonicalStatus");

-- Seed the five SYSTEM definitions (stable ids/keys; today's labels/colors).
INSERT INTO "ProjectStatusDefinition" ("id", "key", "label", "color", "sortOrder", "isActive", "canonicalStatus", "isSystem", "updatedAt") VALUES
    ('pstatus_planning',    'PLANNING',    'Planning',    '#3b82f6', 10, true, 'PLANNING',    true, CURRENT_TIMESTAMP),
    ('pstatus_in_progress', 'IN_PROGRESS', 'In Progress', '#f59e0b', 20, true, 'IN_PROGRESS', true, CURRENT_TIMESTAMP),
    ('pstatus_on_hold',     'ON_HOLD',     'On Hold',     '#fb923c', 30, true, 'ON_HOLD',     true, CURRENT_TIMESTAMP),
    ('pstatus_completed',   'COMPLETED',   'Completed',   '#10b981', 40, true, 'COMPLETED',   true, CURRENT_TIMESTAMP),
    ('pstatus_cancelled',   'CANCELLED',   'Cancelled',   '#d1d5db', 50, true, 'CANCELLED',   true, CURRENT_TIMESTAMP);

-- Add + backfill Project.statusDefinitionId from the existing canonical status.
ALTER TABLE "Project" ADD COLUMN "statusDefinitionId" TEXT;
UPDATE "Project" p SET "statusDefinitionId" = d."id"
  FROM "ProjectStatusDefinition" d
  WHERE d."isSystem" AND d."canonicalStatus" = p."status";
ALTER TABLE "Project" ALTER COLUMN "statusDefinitionId" SET NOT NULL;

CREATE INDEX "Project_statusDefinitionId_idx" ON "Project"("statusDefinitionId");
ALTER TABLE "Project" ADD CONSTRAINT "Project_statusDefinitionId_fkey" FOREIGN KEY ("statusDefinitionId") REFERENCES "ProjectStatusDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity backstop for EVERY write path (app, scripts, raw SQL):
--  * a writer that supplies only the canonical status (no definition, or a
--    status change with the definition untouched) keeps its current
--    definition when that still maps to the new status, otherwise gets the
--    SYSTEM definition of the new status;
--  * the stored definition must always map to the stored canonical status.
CREATE FUNCTION project_status_definition_sync() RETURNS trigger AS $$
DECLARE
  current_canonical "ProjectStatus";
BEGIN
  IF NEW."statusDefinitionId" IS NULL
     OR (TG_OP = 'UPDATE' AND NEW."status" IS DISTINCT FROM OLD."status"
         AND NEW."statusDefinitionId" IS NOT DISTINCT FROM OLD."statusDefinitionId") THEN
    SELECT "canonicalStatus" INTO current_canonical FROM "ProjectStatusDefinition" WHERE "id" = NEW."statusDefinitionId";
    IF current_canonical IS DISTINCT FROM NEW."status" THEN
      SELECT "id" INTO NEW."statusDefinitionId" FROM "ProjectStatusDefinition"
        WHERE "isSystem" AND "canonicalStatus" = NEW."status";
    END IF;
  END IF;
  SELECT "canonicalStatus" INTO current_canonical FROM "ProjectStatusDefinition" WHERE "id" = NEW."statusDefinitionId";
  IF current_canonical IS NULL OR current_canonical <> NEW."status" THEN
    RAISE EXCEPTION 'project_status_mismatch: definition % does not map to canonical status %', NEW."statusDefinitionId", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_status_definition_sync
  BEFORE INSERT OR UPDATE OF "status", "statusDefinitionId" ON "Project"
  FOR EACH ROW EXECUTE FUNCTION project_status_definition_sync();

-- A definition referenced by any Project can never be remapped to another
-- canonical state (would silently change those Projects' lifecycle).
CREATE FUNCTION project_status_definition_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."canonicalStatus" IS DISTINCT FROM OLD."canonicalStatus"
     AND EXISTS (SELECT 1 FROM "Project" WHERE "statusDefinitionId" = OLD."id") THEN
    RAISE EXCEPTION 'project_status_in_use: definition % is referenced by Projects and cannot be remapped', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_status_definition_guard
  BEFORE UPDATE OF "canonicalStatus" ON "ProjectStatusDefinition"
  FOR EACH ROW EXECUTE FUNCTION project_status_definition_guard();
