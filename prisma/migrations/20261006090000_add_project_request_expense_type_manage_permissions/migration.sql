-- Adds `projectRequestType.manage` and `projectExpenseType.manage` — the
-- production-safe counterparts of their prisma/seed.ts PERMISSIONS entries,
-- for the exact same reason documented in
-- 20260930141900_add_project_request_approve_permission and
-- 20261005120000_add_project_request_intermediate_approve_permission: a
-- production environment that runs `prisma migrate deploy` but never
-- re-runs `prisma db seed` would otherwise never gain these keys at all.
--
-- Both resources were previously authorized by the generic `admin.access`
-- permission; each now gets its own independently-grantable `.manage` key,
-- the same normalization `taskType.manage` itself already received
-- (20260919... area — see that key's own seed.ts comment). GLOBAL-only,
-- same tier as taskType.manage (see GLOBAL_ONLY_PERMISSION_KEYS in
-- app/api/admin/roles/[id]/permissions/[permId]/route.ts and
-- app/(main)/admin/roles/page.tsx).
--
-- Safety: additive/idempotent, identical pattern to the two migrations
-- named above — ON CONFLICT DO NOTHING by Permission.key and by
-- RolePermission's (roleKey, permissionId) primary key. Touches ONLY these
-- two permission keys and their ADMIN grants — no other Permission or
-- RolePermission row is read or written by this file.

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'projectRequestType.manage', 'Create, edit, and delete Project Request Types', 'admin', now(), now()),
(gen_random_uuid()::text, 'projectExpenseType.manage', 'Create, edit, and delete Project Expense Types', 'admin', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- ADMIN only, same default-grant rationale as taskType.manage's own
-- migration — cosmetic-only (ADMIN bypasses hasPermission() unconditionally,
-- see lib/permissions.ts) but keeps /admin/roles's Administrator matrix
-- starting fully checked instead of silently incomplete.
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT 'ADMIN', p."id", now()
FROM "Permission" p
WHERE p."key" IN ('projectRequestType.manage', 'projectExpenseType.manage')
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
