-- Adds the `projectRequest.approve` permission key — the SYSTEM approval
-- stage gate for the new Project Request Form workflow (PENDING_SYSTEM_APPROVAL
-- -> APPROVED/REJECTED; see app/api/project-requests/[id]/system-approval/
-- route.ts). Checked via hasEffectiveEntityPermission against each request's
-- OWN departmentId, the exact same global-OR-department-scoped union
-- project.edit/activity.edit/gantt.view already use: a GLOBAL grant approves
-- requests from every department, a DEPARTMENT-scoped grant approves only
-- that department's own requests. Never a hardcoded role name, never an
-- active-workspace shortcut — see lib/services/project-request-service.ts.
--
-- Same production-safe pattern as 20260915110000_add_gantt_view_permission
-- and 20260929100000_add_category_create_permission: prisma/seed.ts's
-- PERMISSIONS/ROLE_PERMISSIONS/NEW_PERMISSION_DEFAULT_GRANTS are DATA-table
-- changes that only take effect if `prisma db seed` is actually (re-)run —
-- a production environment that runs `prisma migrate deploy` but never
-- re-runs the seed would otherwise never gain this key at all. This
-- migration makes projectRequest.approve's existence independent of seed
-- execution and of any application-runtime initialization.
--
-- Safety:
--   * additive/idempotent by Permission.key (ON CONFLICT DO NOTHING) and by
--     RolePermission's (roleKey, permissionId) primary key.
--   * Because this is a brand-new feature with no prior implicit
--     reachability for ANY role (unlike gantt.view, which backfilled every
--     role that could already reach project.view/activity.view data), this
--     migration grants it to exactly ONE roleKey: ADMIN — cosmetic-only
--     (ADMIN bypasses hasPermission() unconditionally — see
--     lib/permissions.ts) but kept for /admin/roles matrix consistency, same
--     as every other ADMIN-only-by-default key (company.create,
--     businessUnit.create, gantt.view's own ADMIN row, category.create).
--   * Deliberately NOT granted to DEPARTMENT_MANAGER/DEPARTMENT_ADMIN/
--     IT_AGENT/any other built-in role, and NOT backfilled onto any existing
--     custom role — the task this migration implements explicitly requires
--     that this new capability starts ADMIN-only and is never auto-granted
--     to every manager/agent; an administrator opts specific roles in later
--     via /admin/roles, same as any other permission.
--   * a Prisma migration is applied at most once per database — a later
--     grant/revocation of projectRequest.approve via /admin/roles is never
--     touched by this file again after that one application.
--   * touches ONLY the `projectRequest.approve` permission key — no other
--     Permission or RolePermission row is read or written by this file.

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'projectRequest.approve', 'Give final (system) approval on Project Requests', 'projectRequests', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- ADMIN only — cosmetic-only (see the comment block above), so
-- /admin/roles's Administrator matrix starts fully checked instead of
-- empty. Runs unconditionally — safe regardless of whether
-- projectRequest.approve already existed, since ON CONFLICT DO NOTHING
-- makes this a true no-op if it's already present.
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT 'ADMIN', p."id", now()
FROM "Permission" p
WHERE p."key" = 'projectRequest.approve'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
