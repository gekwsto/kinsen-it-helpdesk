-- Adds the `projectRequest.intermediateApprove` permission key — the
-- missing production-safe counterpart to
-- 20260930141900_add_project_request_approve_permission, for the exact
-- same reason documented there.
--
-- 20261003090100_add_project_request_intermediate_approver added the
-- ProjectRequestIntermediateApprover TABLE/enum (schema), but never
-- inserted the Permission row or its default ADMIN grant via SQL — those
-- exist only in prisma/seed.ts's PERMISSIONS/ROLE_PERMISSIONS arrays. A
-- production environment that runs `prisma migrate deploy` but never
-- re-runs `prisma db seed` therefore applied the table migration fine but
-- never gained the permission key itself: the New Project Request form's
-- "nobody currently holds projectRequest.intermediateApprove" fail-closed
-- empty state (app/(main)/project-requests/new/page.tsx) is reachable in
-- that state even though the feature's schema is fully present, and
-- /admin/roles's "Project Requests" module shows only 1/1
-- (projectRequest.approve) instead of 2/2.
--
-- Safety: additive/idempotent, identical pattern to
-- 20260930141900_add_project_request_approve_permission — ON CONFLICT DO
-- NOTHING by Permission.key and by RolePermission's (roleKey, permissionId)
-- primary key. Touches ONLY the `projectRequest.intermediateApprove`
-- permission key and its ADMIN grant — no other Permission or
-- RolePermission row is read or written by this file.

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'projectRequest.intermediateApprove', 'Be selectable as an intermediate approver on Project Requests, and decide requests where assigned', 'projectRequests', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- ADMIN only, same default-grant rationale as projectRequest.approve's own
-- migration — cosmetic-only (ADMIN bypasses hasPermission() unconditionally,
-- see lib/permissions.ts) but keeps /admin/roles's Administrator matrix
-- starting fully checked instead of silently incomplete.
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT 'ADMIN', p."id", now()
FROM "Permission" p
WHERE p."key" = 'projectRequest.intermediateApprove'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
