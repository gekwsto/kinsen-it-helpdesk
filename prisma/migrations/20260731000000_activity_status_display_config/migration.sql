-- Additive: adds department-scoped display metadata to the EXISTING
-- ActivityStatusConfig table (never a second/parallel config system) —
-- label, color, sortOrder, isEnabled, alongside the already-present
-- isTerminal. Backfills every existing row from the previous app-wide
-- hardcoded values (components/gantt/status-colors.ts's STATUS_LABEL/
-- STATUS_BAR) so nothing changes visually until an admin edits it, then
-- makes `label` NOT NULL. Never destroys existing isTerminal data.

ALTER TABLE "ActivityStatusConfig" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "ActivityStatusConfig" ADD COLUMN IF NOT EXISTS "color" TEXT NOT NULL DEFAULT '#94a3b8';
ALTER TABLE "ActivityStatusConfig" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ActivityStatusConfig" ADD COLUMN IF NOT EXISTS "isEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Idempotent: only fills rows that don't already have a label (a rerun, or
-- a row an admin already customized, is left untouched).
UPDATE "ActivityStatusConfig" SET "label" = CASE "status"
  WHEN 'TODO' THEN 'To Do'
  WHEN 'IN_PROGRESS' THEN 'In Progress'
  WHEN 'ON_HOLD' THEN 'On Hold'
  WHEN 'BLOCKED' THEN 'Blocked'
  WHEN 'COMPLETED' THEN 'Completed'
  WHEN 'CANCELLED' THEN 'Cancelled'
  ELSE "status"::text
END
WHERE "label" IS NULL;

-- Only rows still at the placeholder column default get the real starter
-- color — never overwrites a value an admin may have already set between
-- the ADD COLUMN and this UPDATE in a live deploy.
UPDATE "ActivityStatusConfig" SET "color" = CASE "status"
  WHEN 'TODO' THEN '#94a3b8'
  WHEN 'IN_PROGRESS' THEN '#f59e0b'
  WHEN 'ON_HOLD' THEN '#fb923c'
  WHEN 'BLOCKED' THEN '#ef4444'
  WHEN 'COMPLETED' THEN '#10b981'
  WHEN 'CANCELLED' THEN '#d1d5db'
  ELSE '#94a3b8'
END
WHERE "color" = '#94a3b8';

UPDATE "ActivityStatusConfig" SET "sortOrder" = CASE "status"
  WHEN 'TODO' THEN 0
  WHEN 'IN_PROGRESS' THEN 1
  WHEN 'ON_HOLD' THEN 2
  WHEN 'BLOCKED' THEN 3
  WHEN 'COMPLETED' THEN 4
  WHEN 'CANCELLED' THEN 5
  ELSE 99
END
WHERE "sortOrder" = 0;

ALTER TABLE "ActivityStatusConfig" ALTER COLUMN "label" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "ActivityStatusConfig_departmentId_isEnabled_idx" ON "ActivityStatusConfig"("departmentId", "isEnabled");
