-- TicketCategory/TicketPriority/TicketStatus.departmentId is now required
-- (see 20260722122518_retire_global_config_scope) — no row can ever have
-- departmentId IS NULL again, so the partial unique indexes added by
-- 20260726090000_add_global_name_uniqueness for these three tables can
-- never match any row. Dropped as dead weight. TicketCancelReason's
-- equivalent index is untouched — Cancel Reasons stay global/shared.
--
-- IF EXISTS added: this migration's filename timestamp (20260722130000) sorts
-- BEFORE 20260726090000_add_global_name_uniqueness, which is the migration
-- that actually creates these three indexes. On a database replaying full
-- history from empty in filename order, this migration used to run before
-- the indexes it drops ever existed, failing outright. See
-- 20260727000000_enforce_config_scope_final_state for the corrective
-- follow-up that finishes this drop on any database where it's skipped here.
DROP INDEX IF EXISTS "TicketCategory_global_name_key";
DROP INDEX IF EXISTS "TicketPriority_global_name_key";
DROP INDEX IF EXISTS "TicketStatus_global_name_key";
