-- Removes Project.budget, Project.estimatedCost and Project.actualCost —
-- all three existed SOLELY for the request-origin Project Request Setup
-- feature (confirmed by audit: no other Project feature anywhere in this
-- codebase ever read or wrote them). Budget has no replacement: the
-- business rule no longer tracks it for request-origin Projects at all.
-- Estimated Cost and Actual Cost are replaced by a fully-derived
-- calculation from the Project's own Activities (taskTypeCost x
-- expectedDays/actualDays, summed) — see
-- lib/services/project-financials-service.ts's computeProjectFinancials,
-- the single authoritative aggregation — never stored again, so the
-- displayed total can never drift from the Activities that make it up.
--
-- This IS destructive: at the time this migration was written, 3 Project
-- rows had a non-null `budget`, 3 had a non-null `estimatedCost`, and 0 had
-- a non-null `actualCost` — those historical manually-entered values are
-- intentionally and permanently discarded by this migration, per this
-- feature's own explicit requirement. No backfill/preservation was
-- requested or performed.
ALTER TABLE "Project" DROP COLUMN "actualCost",
DROP COLUMN "budget",
DROP COLUMN "estimatedCost";
