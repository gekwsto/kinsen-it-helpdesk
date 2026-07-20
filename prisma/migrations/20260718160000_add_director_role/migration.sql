-- Adds DIRECTOR to the global Role enum: a cross-department oversight role
-- (view everything, create projects/activities anywhere) distinct from
-- ADMIN (full system administration). See lib/permissions.ts's
-- canViewAllDepartments().
--
-- Purely additive — no existing row can hold a value that didn't exist
-- before this migration, so there is nothing to backfill and no data risk.

ALTER TYPE "Role" ADD VALUE 'DIRECTOR';
