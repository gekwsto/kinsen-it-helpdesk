-- Adds the `category.create` permission key — a genuinely independent
-- create-only grant for Ticket Categories, matching the sibling
-- priority.create/status.create/cancelReason.create keys already
-- established in this same "ticketConfig" module (see prisma/seed.ts's
-- TICKET_CONFIG_PERMISSION_KEYS). Category creation was previously
-- reachable ONLY via the bundled category.manage key (create+edit
-- together, itself additive over the older department.manageSettings) —
-- this migration does NOT touch or replace category.manage (still required
-- for edit; category.edit was deliberately not introduced here), it only
-- adds category.create as an ADDITIONAL OR-branch for the create action,
-- exactly like category.delete already is for delete (see
-- app/api/admin/categories/route.ts's CATEGORY_CREATE_PERMISSION_KEYS /
-- CATEGORY_DELETE_PERMISSION_KEYS).
--
-- Same production-safe pattern as 20260915110000_add_gantt_view_permission
-- and 20260813113000_backfill_permission_catalog: prisma/seed.ts's
-- PERMISSIONS/ROLE_PERMISSIONS/NEW_PERMISSION_DEFAULT_GRANTS are DATA-table
-- changes that only take effect if `prisma db seed` is actually (re-)run —
-- a production environment that runs `prisma migrate deploy` but never
-- re-runs the seed would otherwise never gain this key, or its backfill,
-- at all. This migration makes category.create's existence AND its
-- default-grant backfill independent of seed execution and of any
-- application-runtime initialization.
--
-- Safety:
--   * additive/idempotent by Permission.key (ON CONFLICT DO NOTHING) and by
--     RolePermission's (roleKey, permissionId) primary key — every INSERT
--     below is unconditionally safe to run against a database where some or
--     all of its target rows already exist, from a prior seed run or
--     otherwise.
--   * built-in role default grants: exactly the 3 roleKeys that currently
--     hold category.manage (ADMIN — via its own PERMISSIONS.map bootstrap
--     of every key — plus DEPARTMENT_MANAGER and DEPARTMENT_ADMIN, both via
--     TICKET_CONFIG_PERMISSION_KEYS in prisma/seed.ts). This preserves each
--     of their CURRENT ability to create a category — nobody's access
--     narrows OR widens here. ADMIN's row is cosmetic-only (ADMIN bypasses
--     hasPermission() unconditionally — see lib/permissions.ts) but kept
--     for /admin/roles matrix consistency, same as gantt.view's ADMIN row.
--   * deliberately NOT granted to IT_AGENT/USER/DIRECTOR/PROJECT_MANAGER/
--     AGENT_ASSIGNEE/REQUESTER/VIEWER or any other built-in role — none of
--     them hold category.manage today, so none of them could create a
--     category before this migration either. This migration must only
--     preserve existing access, never widen it to a role that didn't
--     already have it.
--   * every existing CUSTOM role (global OR department-scoped, isBuiltIn =
--     false) that already holds category.manage gets category.create
--     backfilled too — the same backward-compatibility guarantee as the
--     built-in roles above, for a role an administrator defined themselves.
--   * a Prisma migration is applied at most once per database (tracked in
--     _prisma_migrations) — an administrator's later revocation of
--     category.create from any role via /admin/roles is never touched by
--     this file again after that one application.
--   * touches ONLY the `category.create` permission key — no other
--     Permission or RolePermission row (built-in or custom, any other key,
--     including category.manage/category.delete themselves) is read or
--     written by this file.

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'category.create', 'Create ticket categories', 'ticketConfig', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- Built-in role defaults — the exact 3 roleKeys that already hold
-- category.manage today (see prisma/seed.ts's TICKET_CONFIG_PERMISSION_KEYS
-- spread into DEPARTMENT_MANAGER/DEPARTMENT_ADMIN, plus ADMIN's own
-- PERMISSIONS.map bootstrap). Runs unconditionally — safe regardless of
-- whether category.create already existed, since ON CONFLICT DO NOTHING
-- makes every row here a true no-op if it's already present.
WITH default_grants("roleKey") AS (
  VALUES ('ADMIN'), ('DEPARTMENT_MANAGER'), ('DEPARTMENT_ADMIN')
)
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT dg."roleKey", p."id", now()
FROM default_grants dg
JOIN "Permission" p ON p."key" = 'category.create'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

-- Existing CUSTOM roles (any scope — GLOBAL, DEPARTMENT, or BOTH) that
-- already hold category.manage get category.create backfilled too — the
-- same backward-compatibility guarantee as the built-in roles above, for a
-- role an administrator defined themselves rather than one this app ships
-- with. isBuiltIn = false excludes the built-in Role/DepartmentRole mirror
-- CustomRole rows (see 20260812091426_backfill_builtin_department_roles) —
-- those share their CustomRole.key with the literal built-in roleKey,
-- already granted explicitly above.
--
-- Runs UNCONDITIONALLY, same reasoning as gantt.view's own migration: a
-- database where category.create (and its built-in grants) already exists
-- from a `prisma db seed` run that predates this migration still needs
-- this exact backfill for any pre-existing custom role, since seed.ts's
-- own NEW_PERMISSION_DEFAULT_GRANTS never touches CustomRole rows at all —
-- only the built-in roleKeys above.
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT DISTINCT cr."key", p."id", now()
FROM "CustomRole" cr
JOIN "RolePermission" existing ON existing."roleKey" = cr."key"
JOIN "Permission" existing_perm ON existing_perm."id" = existing."permissionId"
  AND existing_perm."key" = 'category.manage'
JOIN "Permission" p ON p."key" = 'category.create'
WHERE cr."isBuiltIn" = false
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
