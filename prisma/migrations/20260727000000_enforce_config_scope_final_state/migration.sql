-- Corrective, forward-only migration — closes the P3018 ordering bug in
-- 20260722122518_retire_global_config_scope and 20260722130000_drop_dead_global_name_indexes
-- (both dated *before* 20260725090000_add_department_role_and_config_scoping and
-- 20260726090000_add_global_name_uniqueness, which actually create the
-- column/FK/indexes those two migrations depend on). Those two migrations were
-- made order-tolerant (no-op when their dependency doesn't exist yet) rather than
-- edited destructively, since this chain has already shipped/been applied on at
-- least one environment — this migration is the one that guarantees the true
-- end state is reached everywhere, regardless of which order a given database
-- actually replayed the chain in:
--   - On a database where the guarded migrations above ran their real branch
--     (dependency already existed), every block below is already satisfied and
--     is a pure no-op.
--   - On a database that replayed the full history from empty in filename
--     order and hit the now-guarded no-op path instead, this finishes the job.
-- Fully idempotent; safe to apply any number of times.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TicketCategory' AND column_name = 'departmentId' AND is_nullable = 'YES'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'TicketCategory_departmentId_fkey' AND conrelid = '"TicketCategory"'::regclass
    ) THEN
      ALTER TABLE "TicketCategory" DROP CONSTRAINT "TicketCategory_departmentId_fkey";
    END IF;
    ALTER TABLE "TicketCategory" ALTER COLUMN "departmentId" SET NOT NULL;
    ALTER TABLE "TicketCategory" ADD CONSTRAINT "TicketCategory_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TicketPriority' AND column_name = 'departmentId' AND is_nullable = 'YES'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'TicketPriority_departmentId_fkey' AND conrelid = '"TicketPriority"'::regclass
    ) THEN
      ALTER TABLE "TicketPriority" DROP CONSTRAINT "TicketPriority_departmentId_fkey";
    END IF;
    ALTER TABLE "TicketPriority" ALTER COLUMN "departmentId" SET NOT NULL;
    ALTER TABLE "TicketPriority" ADD CONSTRAINT "TicketPriority_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TicketStatus' AND column_name = 'departmentId' AND is_nullable = 'YES'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'TicketStatus_departmentId_fkey' AND conrelid = '"TicketStatus"'::regclass
    ) THEN
      ALTER TABLE "TicketStatus" DROP CONSTRAINT "TicketStatus_departmentId_fkey";
    END IF;
    ALTER TABLE "TicketStatus" ALTER COLUMN "departmentId" SET NOT NULL;
    ALTER TABLE "TicketStatus" ADD CONSTRAINT "TicketStatus_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Dead partial global-name indexes (see 20260722130000_drop_dead_global_name_indexes) —
-- guaranteed to exist by this point (20260726090000 always precedes this
-- migration by filename order) and safe to drop unconditionally either way.
DROP INDEX IF EXISTS "TicketCategory_global_name_key";
DROP INDEX IF EXISTS "TicketPriority_global_name_key";
DROP INDEX IF EXISTS "TicketStatus_global_name_key";
