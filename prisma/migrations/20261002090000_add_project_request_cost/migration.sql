-- Adds a monetary cost to Project Request Types, and a snapshot of that
-- cost on each Project Request taken at submission time.
--
-- Purely additive, both columns nullable, no backfill — this app already
-- has ProjectRequestType/ProjectRequest rows in the dev database and no
-- authoritative historical cost exists for any of them. Assigning a
-- fabricated value (including 0.00) would be incorrect; NULL is the only
-- honest representation of "no cost was ever recorded for this row".
--
-- Decimal(10,2) (PostgreSQL NUMERIC(10,2)) — exact currency precision up to
-- 99,999,999.99, never a float/double column.

ALTER TABLE "ProjectRequestType" ADD COLUMN "cost" DECIMAL(10,2);
ALTER TABLE "ProjectRequest" ADD COLUMN "cost" DECIMAL(10,2);
