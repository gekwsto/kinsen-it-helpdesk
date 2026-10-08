-- Classification model rename (non-destructive — every rename below
-- preserves existing rows/ids/values; nothing is dropped or recreated):
--
--   ProjectRequestType  -> TaskType     (moves from a ProjectRequest-only
--                                        classification to an Activity
--                                        classification; "Project Type")
--   ActivityTaskType    -> TaskSubType  (same concept, renamed; "Task Type")
--
-- See prisma/schema.prisma's own doc comments on TaskType/TaskSubType/
-- ProjectActivity for the full rationale.

-- ProjectRequestType -> TaskType: same table, same rows, same ids.
ALTER TABLE "ProjectRequestType" RENAME TO "TaskType";
ALTER TABLE "TaskType" RENAME CONSTRAINT "ProjectRequestType_pkey" TO "TaskType_pkey";
ALTER INDEX "ProjectRequestType_name_key" RENAME TO "TaskType_name_key";

-- ActivityTaskType -> TaskSubType: same table, same rows (name/cost/
-- isActive values untouched), same ids.
ALTER TABLE "ActivityTaskType" RENAME TO "TaskSubType";
ALTER TABLE "TaskSubType" RENAME CONSTRAINT "ActivityTaskType_pkey" TO "TaskSubType_pkey";
ALTER INDEX "ActivityTaskType_name_key" RENAME TO "TaskSubType_name_key";

-- Task Sub Type cost becomes OPTIONAL — some Sub Types (e.g. "Others",
-- "External") have no fixed predefined cost. Every existing row keeps its
-- current cost value exactly as it is; only the NOT NULL constraint is
-- lifted, so a future admin edit may explicitly clear it to null.
ALTER TABLE "TaskSubType" ALTER COLUMN "cost" DROP NOT NULL;

-- ProjectActivity: the EXISTING taskTypeId/taskTypeCost pair (which has
-- always pointed at what is now TaskSubType) is renamed to
-- taskSubTypeId/taskSubTypeCost — freeing the name taskTypeId/taskTypeCost
-- up for the BRAND NEW, unrelated Task Type classification added below.
-- Every existing Activity's historical Task Sub Type selection and cost
-- snapshot is preserved exactly: same column, same values, same
-- referenced row — only the column's own name changes.
ALTER TABLE "ProjectActivity" RENAME COLUMN "taskTypeId" TO "taskSubTypeId";
ALTER TABLE "ProjectActivity" RENAME COLUMN "taskTypeCost" TO "taskSubTypeCost";
ALTER TABLE "ProjectActivity" RENAME CONSTRAINT "ProjectActivity_taskTypeId_fkey" TO "ProjectActivity_taskSubTypeId_fkey";
ALTER INDEX "ProjectActivity_taskTypeId_idx" RENAME TO "ProjectActivity_taskSubTypeId_idx";

-- New, independent Task Type classification on Activity (the former
-- Project Request Type, now moved here) — nullable at the DB level
-- because every EXISTING Activity (created before this classification
-- existed on Activity at all) never had one selected and can never be
-- safely backfilled with a fabricated choice; required ONLY at the
-- application boundary for new Activity creation going forward (see
-- createActivitySchema in lib/validations.ts and POST /api/activities's
-- own re-validation) — the exact same "nullable at DB, required at
-- creation" pattern this schema already uses for every other
-- request-origin-only Activity field (expectedStartDate, ownerId, etc).
ALTER TABLE "ProjectActivity" ADD COLUMN "taskTypeId" TEXT;
CREATE INDEX "ProjectActivity_taskTypeId_idx" ON "ProjectActivity"("taskTypeId");
ALTER TABLE "ProjectActivity" ADD CONSTRAINT "ProjectActivity_taskTypeId_fkey" FOREIGN KEY ("taskTypeId") REFERENCES "TaskType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ProjectRequest.projectTypeId: no longer required at submission (the
-- classification moved to Activity — removed from
-- createProjectRequestSchema and the Project Request Form). Made
-- NULLABLE so every EXISTING historical row keeps its real,
-- already-persisted value forever, untouched — new requests simply never
-- populate it going forward. The pre-existing FK (ON DELETE RESTRICT) is
-- left exactly as it was: a historically-referenced TaskType row still
-- can't be hard-deleted, the same protection as before this migration.
ALTER TABLE "ProjectRequest" ALTER COLUMN "projectTypeId" DROP NOT NULL;

-- Permission DESCRIPTIONS updated to match the renamed concepts. The
-- permission KEYS themselves ("projectRequestType.manage",
-- "taskType.manage") are deliberately UNCHANGED — renaming a
-- Permission.key would silently orphan every existing RolePermission
-- grant referencing that exact string, with no safe automatic way to
-- re-point them. Purely cosmetic, same idempotent pattern already used by
-- prior permission-description migrations in this history.
UPDATE "Permission" SET description = 'Create, edit, and delete Task Types (a global Activity classification)' WHERE "key" = 'projectRequestType.manage';
UPDATE "Permission" SET description = 'Create, edit, and delete Task Sub Types (global reference data)' WHERE "key" = 'taskType.manage';
