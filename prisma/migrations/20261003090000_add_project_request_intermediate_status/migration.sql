-- Adds the new ProjectRequestStatus value for the upcoming intermediate
-- (unanimous, requester-selected multi-approver) approval stage.
--
-- Split into its OWN migration, deliberately separate from the migration
-- that actually uses this value (as a column default) — PostgreSQL forbids
-- using a newly added enum value within the same transaction that added it
-- (ALTER TYPE ... ADD VALUE commits the catalog change but cannot be
-- combined with a use of that value in one transaction, even on PG18).
--
-- Existing rows are completely unaffected — this only adds a new possible
-- value to the enum type; no row's status column is touched.

ALTER TYPE "ProjectRequestStatus" ADD VALUE 'PENDING_INTERMEDIATE_APPROVAL' BEFORE 'PENDING_APPROVAL';
