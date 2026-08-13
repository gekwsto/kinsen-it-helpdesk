-- Adds two new permission keys: ticket.view.all (gates "All Tickets" /
-- full-department ticket visibility, replacing the old hardcoded
-- DepartmentRole.REQUESTER role-name check in splitTicketViewScope /
-- lib/services/department-scope-service.ts) and ticket.closed.view (gates
-- the "Closed Tickets" archive, replacing the old hardcoded
-- isAdmin(role)/roles:["ADMIN"] sidebar+page check).
--
-- Safety:
--   * additive/idempotent by Permission.key and RolePermission PK
--   * default grants for built-in roles preserve their CURRENT effective
--     behavior exactly (see the comment above each default_grants block)
--   * existing CUSTOM department-scoped roles that already have ticket.view
--     ALSO get ticket.view.all backfilled — under the OLD hardcoded logic
--     ANY custom role's DepartmentMembership.role placeholder is always
--     DepartmentRole.VIEWER (never REQUESTER — see
--     grantManualMembership's own doc comment), so every existing custom
--     role already behaved as "full view" today; this preserves that
--     exact behavior rather than silently narrowing it the moment this
--     migration ships. ticket.closed.view has no such concern: it was
--     strictly ADMIN-only before this migration, so there is nothing to
--     backfill for any non-ADMIN role, built-in or custom.
--   * never deletes or re-adds anything for a permission key that already
--     existed before this migration

CREATE TEMP TABLE "_TicketPermissionBackfillInserted" (
  "key" TEXT PRIMARY KEY
);

WITH inserted AS (
  INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
  VALUES
  (gen_random_uuid()::text, 'ticket.view.all', 'View the full department ticket list, not just your own', 'tickets', now(), now()),
  (gen_random_uuid()::text, 'ticket.closed.view', 'View closed, resolved, and cancelled tickets', 'tickets', now(), now())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
INSERT INTO "_TicketPermissionBackfillInserted" ("key")
SELECT "key" FROM inserted;

-- Built-in role defaults — ONLY applied for permission keys genuinely new
-- in this deployment (the join against _TicketPermissionBackfillInserted
-- below), so a second run of this migration (or one that finds the keys
-- already present from a prior partial run) is a true no-op.
WITH default_grants("roleKey", "permissionKey") AS (
  VALUES
    -- ticket.view.all — every built-in role that currently sees the full
    -- department ticket list (i.e. every ticket-viewing role except
    -- REQUESTER) gets it explicitly, so the switch from role-name-based to
    -- permission-based scoping changes zero effective behavior for any
    -- built-in role. ADMIN's row is cosmetic-only (ADMIN bypasses via
    -- canViewAllDepartments before this key is ever consulted — same
    -- rationale as its blanket grant in the original permission catalogue
    -- migration) but kept for /admin/roles matrix consistency.
    ('ADMIN', 'ticket.view.all'),
    ('IT_AGENT', 'ticket.view.all'),
    ('DEPARTMENT_MANAGER', 'ticket.view.all'),
    ('DIRECTOR', 'ticket.view.all'),
    ('DEPARTMENT_ADMIN', 'ticket.view.all'),
    ('AGENT_ASSIGNEE', 'ticket.view.all'),
    ('VIEWER', 'ticket.view.all'),
    -- ticket.closed.view — ADMIN only, preserving the exact pre-migration
    -- isAdmin(role)-only behavior. No other built-in role ever had Closed
    -- Tickets access before this migration, so none is granted it here;
    -- an admin can grant it to any role/custom role going forward via
    -- Roles & Permissions.
    ('ADMIN', 'ticket.closed.view')
)
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT dg."roleKey", p."id", now()
FROM default_grants dg
JOIN "_TicketPermissionBackfillInserted" i ON i."key" = dg."permissionKey"
JOIN "Permission" p ON p."key" = dg."permissionKey"
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

-- Existing CUSTOM department-scoped roles that already have ticket.view —
-- backfill ticket.view.all onto them too, for the exact backward-
-- compatibility reason explained in the header comment above. Restricted
-- to DEPARTMENT/BOTH scope: a GLOBAL-only custom role is never consulted
-- by splitTicketViewScope (department-membership-scoped only), so granting
-- it there would be inert, not harmful, but is skipped for a cleaner
-- default grant set. isBuiltIn = false excludes the built-in DepartmentRole
-- mirrors (see the 20260812091426_backfill_builtin_department_roles
-- migration) — those share their CustomRole.key with the literal enum name
-- (e.g. 'REQUESTER'), which the static default_grants block above already
-- handles explicitly and deliberately excludes REQUESTER from; without
-- this guard, REQUESTER's mirror row would incorrectly pick up
-- ticket.view.all here (it already has 'ticket.view'), silently undoing
-- that exclusion.
INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT cr."key", p."id", now()
FROM "CustomRole" cr
JOIN "RolePermission" existing_view ON existing_view."roleKey" = cr."key"
JOIN "Permission" existing_view_perm ON existing_view_perm."id" = existing_view."permissionId" AND existing_view_perm."key" = 'ticket.view'
JOIN "Permission" p ON p."key" = 'ticket.view.all'
WHERE cr."scope" IN ('DEPARTMENT', 'BOTH')
  AND cr."isBuiltIn" = false
  AND EXISTS (SELECT 1 FROM "_TicketPermissionBackfillInserted" i WHERE i."key" = 'ticket.view.all')
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;

DROP TABLE "_TicketPermissionBackfillInserted";
