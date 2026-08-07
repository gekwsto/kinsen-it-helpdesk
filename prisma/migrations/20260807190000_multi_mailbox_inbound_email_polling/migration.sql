-- Hand-written (not `prisma migrate dev` auto-generated), matching this
-- repo's established convention for additive/non-destructive changes.
--
-- Supports multi-mailbox inbound email polling: Department.inboundEmail
-- addresses are now actually polled as Graph mailboxes, not just used as a
-- routing address after a message already landed in the central mailbox.
--
-- 1. TicketMessage.emailMessageId becomes a REAL DB-unique constraint
--    (replacing the old plain index) — closes a concurrent-processing gap
--    (two overlapping poll runs could otherwise both pass the app-level
--    findFirst dedup check before either committed). Confirmed via direct
--    query before writing this migration: zero existing duplicate/non-null
--    emailMessageId values in TicketMessage — safe to add immediately, no
--    backfill/reconciliation needed. Postgres unique indexes permit any
--    number of NULL rows, so in-app-composed messages (which never set this
--    field) are completely unaffected.
DROP INDEX "TicketMessage_emailMessageId_idx";
CREATE UNIQUE INDEX "TicketMessage_emailMessageId_key" ON "TicketMessage" ("emailMessageId");

-- 2. Per-mailbox polling diagnostics — both nullable/additive, zero impact
--    on existing rows or application logic that doesn't read them.
ALTER TABLE "EmailProcessingLog" ADD COLUMN "mailbox" TEXT;
CREATE INDEX "EmailProcessingLog_mailbox_idx" ON "EmailProcessingLog" ("mailbox");

ALTER TABLE "EmailPollRun" ADD COLUMN "mailboxResults" JSONB;
