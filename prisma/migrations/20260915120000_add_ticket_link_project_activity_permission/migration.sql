-- Adds the `ticket.linkProjectActivity` permission key — replaces what was
-- previously a hardcoded `role === Role.ADMIN` check (never routed through
-- RolePermission at all) in both app/api/tickets/route.ts's ticket-creation
-- POST and app/api/tickets/[id]/route.ts's PATCH, gating whether a ticket
-- can be linked to a Project or Activity. Checked as a plain global
-- permission (hasPermission), never department-scoped — matching this
-- exact route's own established treatment of its other "admin-adjacent"
-- ticket actions (ticket.reply, ticket.internalNote, ticket.share.department,
-- ticket.share.subdepartment all resolve the same way, unlike
-- ticket.changeStatus/ticket.assign which are department-scoped via
-- canActOnEntity).
--
-- Same root cause this migration exists to avoid as the other permission-
-- catalogue migrations in this project (20260813113000_backfill_permission_catalog,
-- 20260813150000_add_ticket_view_all_and_closed_view_permissions,
-- 20260915110000_add_gantt_view_permission): prisma/seed.ts's own
-- PERMISSIONS/ROLE_PERMISSIONS/NEW_PERMISSION_DEFAULT_GRANTS are DATA-table
-- changes that only take effect if `prisma db seed` is actually (re-)run —
-- a production environment that runs `prisma migrate deploy` but never
-- re-runs the seed would otherwise never gain this key at all, silently
-- leaving the OLD hardcoded ADMIN-only behavior in the route code with no
-- way to ever grant it to anyone else.
--
-- Safety:
--   * additive/idempotent by Permission.key (ON CONFLICT DO NOTHING) and by
--     RolePermission's (roleKey, permissionId) primary key.
--   * granted to ADMIN only — this key never existed as a grantable
--     permission before (the old check was a bare role-name comparison,
--     never consulted for ANY custom role or any other built-in role), so
--     there is no other role's "already had this implicitly" backward-
--     compatibility concern to backfill, unlike gantt.view's project.view/
--     activity.view case. ADMIN's own grant is cosmetic-only (ADMIN
--     bypasses hasPermission() unconditionally — lib/permissions.ts) but
--     kept so the /admin/roles Administrator matrix shows it checked,
--     matching every sibling permission-catalogue migration's own ADMIN
--     entry.
--   * touches ONLY the `ticket.linkProjectActivity` permission key — no
--     other Permission or RolePermission row (built-in or custom, any
--     other key) is read or written by this file.
--   * runs unconditionally (no "was this the run that inserted it" gate) —
--     safe regardless of prior state, and a Prisma migration is applied at
--     most once per database (tracked in _prisma_migrations) in any case,
--     so an administrator's later grant/revocation of this permission via
--     /admin/roles is never touched by this file again after that one
--     application.

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'ticket.linkProjectActivity', 'Link a ticket to a Project or Activity', 'tickets', now(), now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT 'ADMIN', p."id", now()
FROM "Permission" p
WHERE p."key" = 'ticket.linkProjectActivity'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
