-- Database-backed idempotency for lifecycle notification emails (ticket
-- created / ticket closed) — a plain application-level findFirst-before-send
-- check has a TOCTOU race under concurrent or retried requests, so the
-- actual guard is a unique constraint: whichever request's INSERT with a
-- given eventKey succeeds atomically owns that event; any other request for
-- the same event gets a unique-constraint violation (P2002) and backs off.
--
-- Purely additive:
--   - CREATED is a new EmailNotificationType value (no existing row can
--     already hold it).
--   - PENDING is a new EmailNotificationStatus value (no existing row can
--     already hold it) — used as the initial "claimed, not yet resolved"
--     state before a row is updated to SENT/FAILED/SKIPPED.
--   - eventKey is a new, nullable column. Existing rows (all REPLY, from
--     before this migration) get NULL, which is fully compatible with a
--     unique index — Postgres allows unlimited NULLs under UNIQUE. No
--     backfill needed or possible (REPLY notifications were never
--     eventKey-deduplicated and aren't being changed here).
--
-- Postgres requires ALTER TYPE ... ADD VALUE to run outside the same
-- transaction as anything that uses the new value — matches the existing
-- precedent in this project (see the add_director_role and
-- add_job_title_mapping migrations), each ADD VALUE alone with no other
-- statement touching that type in the same file.

ALTER TYPE "EmailNotificationType" ADD VALUE IF NOT EXISTS 'CREATED';
ALTER TYPE "EmailNotificationStatus" ADD VALUE IF NOT EXISTS 'PENDING';

-- Nullable, additive column — doesn't reference either new enum value, so
-- it's safe to add in the same migration file/transaction as the ADD VALUE
-- statements above.
ALTER TABLE "EmailNotificationLog" ADD COLUMN IF NOT EXISTS "eventKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "EmailNotificationLog_eventKey_key" ON "EmailNotificationLog"("eventKey");
