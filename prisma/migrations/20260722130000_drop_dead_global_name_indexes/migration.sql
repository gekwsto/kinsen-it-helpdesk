-- TicketCategory/TicketPriority/TicketStatus.departmentId is now required
-- (see 20260722122518_retire_global_config_scope) — no row can ever have
-- departmentId IS NULL again, so the partial unique indexes added by
-- 20260726090000_add_global_name_uniqueness for these three tables can
-- never match any row. Dropped as dead weight. TicketCancelReason's
-- equivalent index is untouched — Cancel Reasons stay global/shared.
DROP INDEX "TicketCategory_global_name_key";
DROP INDEX "TicketPriority_global_name_key";
DROP INDEX "TicketStatus_global_name_key";
