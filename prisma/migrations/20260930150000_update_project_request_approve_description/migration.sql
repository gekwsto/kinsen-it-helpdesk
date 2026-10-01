-- Realigns the `projectRequest.approve` permission's description to
-- explicitly name both outcomes it gates — Approve AND Reject/decline at
-- the system approval stage — since this single key controls both (a
-- single permission check in decideAsSystem, lib/services/
-- project-request-service.ts, before the decision branches; there is no
-- separate decline-only permission). The original wording ("...final
-- (system) approval on Project Requests") only mentioned approval, which
-- was misleading about scope.
--
-- Safety: idempotent (a plain UPDATE keyed by the unique `key` column —
-- safe to run any number of times, matches the row it targets exactly or
-- touches nothing at all). Does NOT insert the row — the prior migration
-- (20260930141900_add_project_request_approve_permission) already does
-- that; if this runs on a database that somehow never got that migration,
-- this UPDATE simply matches zero rows, a no-op. Touches ONLY the
-- `description` column of the single `projectRequest.approve` row — no
-- other Permission field, no RolePermission grant, is read or written.

UPDATE "Permission"
SET "description" = 'Give final (system) approval or rejection on Project Requests', "updatedAt" = now()
WHERE "key" = 'projectRequest.approve';
