-- Adds the `projectRequest.skipIntermediateApproval` permission key — the
-- missing production-safe counterpart to
-- 20260930141900_add_project_request_approve_permission and
-- 20261005120000_add_project_request_intermediate_approve_permission, for
-- the exact same reason documented there.
--
-- 20261029191639_project_request_intermediate_approval_skip_reason added
-- the IntermediateApprovalSkipReason enum and ProjectRequest.
-- intermediateApprovalSkipReason column (schema), but never inserted the
-- Permission row itself — that exists only in prisma/seed.ts's
-- PERMISSIONS array. A production environment that runs
-- `prisma migrate deploy` but never re-runs the (separately broken, see
-- that script's own pre-existing Department-seeding issue) `prisma db
-- seed` therefore applies the column migration fine but never gains the
-- permission key: the New Project Request form's skip-eligibility check
-- (hasExplicitSkipIntermediateApprovalGrant) can never return true for
-- anyone, and /admin/roles's "Project Requests" module shows only 2/3
-- (projectRequest.approve, projectRequest.intermediateApprove) instead of
-- 3/3, even though the feature's schema is fully present.
--
-- Deliberately DIFFERENT from the two precedent migrations above in one
-- way: NO default RolePermission grant is inserted here, not even
-- ADMIN's usual cosmetic one. This permission is checked via
-- hasExplicitSkipIntermediateApprovalGrant (lib/services/project-request-
-- approver-eligibility-service.ts), which deliberately never bypasses for
-- Role.ADMIN or any canViewAllDepartments role (DIRECTOR) — for this one
-- key, a RolePermission row is a REAL, operative grant, not a cosmetic
-- one, so inserting an ADMIN row here would silently auto-grant it,
-- exactly what this feature's own design explicitly avoids. Zero rows
-- means zero holders by default, everywhere (dev, seeded, and production
-- alike) until an admin explicitly assigns it via /admin/roles.
--
-- Safety: additive/idempotent, same ON CONFLICT DO NOTHING pattern as the
-- two precedent migrations. Touches ONLY the
-- `projectRequest.skipIntermediateApproval` permission key — no other
-- Permission or RolePermission row is read or written by this file, and
-- no existing ProjectRequest row (or any other data) is touched at all.

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'projectRequest.skipIntermediateApproval', 'Skip intermediate approval on your own Project Request submissions, going straight to Final Approval', 'projectRequests', now(), now())
ON CONFLICT ("key") DO NOTHING;
