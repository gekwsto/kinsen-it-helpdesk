-- Closes a real Postgres gap: the existing @@unique([departmentId, name])
-- compound index (see 20260714120000_add_department_workspace_model and
-- 20260725090000_add_department_role_and_config_scoping) does NOT prevent
-- two rows with departmentId = NULL and the same name, because Postgres
-- treats every NULL as distinct from every other NULL in a unique index.
-- This adds a partial unique index per entity covering ONLY the global
-- (departmentId IS NULL) case, normalized (trim + lowercase) so
-- whitespace/case variants are caught too. The non-null case is already
-- correctly enforced by the existing compound index and is left untouched.
--
-- Guard: this migration will FAIL LOUDLY with an explicit message if
-- duplicate global rows still exist, rather than letting CREATE UNIQUE INDEX
-- fail with a generic "duplicate key value violates unique constraint"
-- error. If you see this exception, run
-- `npx tsx scripts/audit-and-dedupe-config.ts --apply` first, then re-run
-- `npx prisma migrate deploy`.
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM "TicketCategory" WHERE "departmentId" IS NULL GROUP BY lower(btrim(name)) HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM "TicketPriority" WHERE "departmentId" IS NULL GROUP BY lower(btrim(name)) HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM "TicketStatus" WHERE "departmentId" IS NULL GROUP BY lower(btrim(name)) HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM "TicketCancelReason" WHERE "departmentId" IS NULL GROUP BY lower(btrim(name)) HAVING count(*) > 1
  ) AS dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Duplicate global (departmentId IS NULL) config rows found (% group(s)) — run `npx tsx scripts/audit-and-dedupe-config.ts --apply` before this migration.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "TicketCategory_global_name_key" ON "TicketCategory" (lower(btrim(name))) WHERE "departmentId" IS NULL;
CREATE UNIQUE INDEX "TicketPriority_global_name_key" ON "TicketPriority" (lower(btrim(name))) WHERE "departmentId" IS NULL;
CREATE UNIQUE INDEX "TicketStatus_global_name_key" ON "TicketStatus" (lower(btrim(name))) WHERE "departmentId" IS NULL;
CREATE UNIQUE INDEX "TicketCancelReason_global_name_key" ON "TicketCancelReason" (lower(btrim(name))) WHERE "departmentId" IS NULL;
