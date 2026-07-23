/*
  Warnings:

  - Made the column `departmentId` on table `TicketCategory` required. This step will fail if there are existing NULL values in that column.
  - Made the column `departmentId` on table `TicketPriority` required. This step will fail if there are existing NULL values in that column.
  - Made the column `departmentId` on table `TicketStatus` required. This step will fail if there are existing NULL values in that column.

*/
-- Guarded/order-tolerant rewrite (see 20260727000000_enforce_config_scope_final_state
-- for why): this migration's filename timestamp (20260722122518) sorts BEFORE
-- 20260725090000_add_department_role_and_config_scoping, which is the migration
-- that actually adds the departmentId column + FK to TicketPriority/TicketStatus
-- in the first place (TicketCategory already had it from 20260714120000). On any
-- database replaying the full migration history from empty in filename order —
-- a fresh clone, CI, a new environment — this migration used to run BEFORE its
-- own dependency existed, failing with P3018 ("constraint ... does not exist",
-- Postgres 42704) on the unconditional DROP CONSTRAINT below. Each block is now
-- guarded to a no-op when the column it depends on isn't there yet; the
-- corrective migration at the tip of the chain finishes the job for any database
-- that hit that no-op path. Databases that already applied the original,
-- unguarded version of this migration (checksums don't gate re-runs; already
-- applied migrations are never re-executed) are unaffected — this rewrite
-- produces the identical end state their DB already has.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'TicketCategory' AND column_name = 'departmentId'
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
    WHERE table_name = 'TicketPriority' AND column_name = 'departmentId'
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
    WHERE table_name = 'TicketStatus' AND column_name = 'departmentId'
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
