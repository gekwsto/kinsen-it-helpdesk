-- Adds the `gantt.view` permission key — a capability gate for the Gantt UI
-- itself (Project Gantt = gantt.view AND project.view; Activity Gantt =
-- gantt.view AND activity.view; see lib/services/department-scope-service.ts),
-- NEVER a replacement for the underlying project.view/activity.view
-- authorization or the department DATA scoping those already apply
-- (buildProjectListWhere/buildActivityListWhere are untouched by this key).
--
-- Same root cause this migration exists to avoid as
-- 20260813113000_backfill_permission_catalog and
-- 20260813150000_add_ticket_view_all_and_closed_view_permissions: prisma/
-- seed.ts's PERMISSIONS/ROLE_PERMISSIONS/NEW_PERMISSION_DEFAULT_GRANTS are
-- DATA-table changes that only take effect if `prisma db seed` is actually
-- (re-)run — a production environment that runs `prisma migrate deploy` but
-- never re-runs the seed would otherwise never gain this key, or its
-- backfill, at all. This migration makes gantt.view's existence AND both of
-- its default-grant backfills independent of seed execution and of any
-- application-runtime initialization.
--
-- Safety:
--   * additive/idempotent by Permission.key (ON CONFLICT DO NOTHING) and by
--     RolePermission's (roleKey, permissionId) primary key — every INSERT
--     below is unconditionally safe to run against a database where some or
--     all of its target rows already exist, from a prior seed run or
--     otherwise. None of the three statements below are gated on whether
--     THIS statement is what inserted the Permission row — each is its own
--     independent, idempotent repair, so a database that already has
--     gantt.view (e.g. from `prisma db seed` run before this migration
--     shipped) still gets its custom-role backfill applied on this
--     migration's one-time application, with no manual DB operation.
--   * built-in role default grants (ALL 10 roleKeys currently reachable via
--     project.view or activity.view — see prisma/seed.ts's own
--     NEW_PERMISSION_DEFAULT_GRANTS/ROLE_PERMISSIONS for gantt.view, which
--     this list matches exactly) preserve each role's CURRENT effective
--     Gantt reachability exactly — nobody's access narrows the moment this
--     migration ships
--   * EVERY existing CUSTOM role (global OR department-scoped, isBuiltIn =
--     false) that already holds project.view OR activity.view — and does
--     not already hold gantt.view — is backfilled too, for the same
--     backward-compatibility reason: a custom role that could already
--     reach the Gantt UI's underlying data keeps being able to see the
--     Gantt UI itself. This runs unconditionally on this migration's one
--     application, regardless of whether gantt.view (or any of its
--     built-in grants) already existed beforehand.
--   * a Prisma migration is applied at most once per database (tracked in
--     _prisma_migrations) — an administrator's later revocation of
--     gantt.view from any role via /admin/roles is never touched by this
--     file again after that one application, so no additional "only if
--     newly inserted" guard is needed for revocation-permanence; that
--     guarantee comes from Prisma's own apply-once semantics, not from
--     this SQL. This file is not written to be manually re-executed
--     outside Prisma's migration tracking.
--   * touches ONLY the `gantt.view` permission key — no other Permission or
--     RolePermission row (built-in or custom, any other key) is read or
--     written by this file

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'gantt.view', 'View Gantt timelines', 'projects', now(), now())
ON CONFLICT ("key") DO NOTHING;

-- Built-in role defaults — every roleKey that seed.ts's own
-- NEW_PERMISSION_DEFAULT_GRANTS/ROLE_PERMISSIONS.gantt.view list already
-- grants it to (all 10: every built-in Role and DepartmentRole currently
-- reachable via project.view or activity.view). ADMIN's row is
-- cosmetic-only (ADMIN bypasses hasPermission() unconditionally — same
-- rationale as its blanket grants in the earlier permission-catalogue
-- migrations) but kept for /admin/roles matrix consistency. Runs
-- unconditionally — safe regardless of whether gantt.view already existed,
-- since ON CONFLICT DO NOTHING makes every row here a true no-op if it's
-- already present.
WITH default_grants("roleKey") AS (
  VALUES ('ADMIN'), ('IT_AGENT'), ('DEPARTMENT_MANAGER'), ('USER'), ('DIRECTOR'),
         ('DEPARTMENT_ADMIN'), ('PROJECT_MANAGER'), ('AGENT_ASSIGNEE'), ('REQUESTER'), ('VIEWER')
)
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT dg."roleKey", p."id", now()
FROM default_grants dg
JOIN "Permission" p ON p."key" = 'gantt.view'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

-- Existing CUSTOM roles (any scope — GLOBAL, DEPARTMENT, or BOTH; unlike
-- ticket.view.all's migration this is never restricted to DEPARTMENT/BOTH,
-- because gantt.view's own union rule (hasEffectiveModulePermission) checks
-- a GLOBAL grant exactly the same way as a department-scoped one) that
-- already hold project.view OR activity.view get gantt.view backfilled too
-- — the same backward-compatibility guarantee as the built-in roles above,
-- for a role an administrator defined themselves rather than one this app
-- ships with. isBuiltIn = false excludes the built-in Role/DepartmentRole
-- mirror CustomRole rows (see 20260812091426_backfill_builtin_department_roles)
-- — those share their CustomRole.key with the literal built-in roleKey
-- (e.g. 'REQUESTER'), already granted explicitly above; without this guard
-- a mirror row would be touched twice (harmlessly, since both are
-- ON CONFLICT DO NOTHING) but this keeps the two grant sources cleanly
-- separated, matching the established precedent's own reasoning.
--
-- Runs UNCONDITIONALLY — this is the actual fix this migration exists for:
-- a database where gantt.view (and its built-in grants) already exists
-- from a `prisma db seed` run that predates this migration still needs
-- this exact backfill for any pre-existing custom role, since seed.ts's
-- own NEW_PERMISSION_DEFAULT_GRANTS never touches CustomRole rows at all —
-- only the 10 built-in roleKeys above. Never gated on whether THIS
-- statement is what inserted the Permission row.
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT DISTINCT cr."key", p."id", now()
FROM "CustomRole" cr
JOIN "RolePermission" existing ON existing."roleKey" = cr."key"
JOIN "Permission" existing_perm ON existing_perm."id" = existing."permissionId"
  AND existing_perm."key" IN ('project.view', 'activity.view')
JOIN "Permission" p ON p."key" = 'gantt.view'
WHERE cr."isBuiltIn" = false
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
