-- Corrective backfill migration.
--
-- Root-cause bug (found during a live audit of the Microsoft Directory Sync
-- feature): createDepartment() (lib/services/department-service.ts) always
-- created starter TicketPriority rows for a brand-new department but, until
-- a recent fix, never created any TicketStatus rows — despite its own
-- header comment promising a complete starter set. Every department that
-- was ever created purely through createDepartment() BEFORE that fix
-- (admin-created via app/api/admin/departments/route.ts, or
-- Microsoft-sync-created via lib/services/organization-company-department-resolver.ts)
-- may exist today with ZERO TicketStatus rows and therefore cannot have a
-- ticket created for it at all (no default status to assign).
--
-- This migration backfills EXACTLY the same starter set
-- lib/services/config-starter-data.ts's STARTER_STATUSES / ensureStarterStatusesForDepartment()
-- would create — same names, colors, isDefault/isClosed flags, and order —
-- so a department fixed by this migration is byte-for-byte indistinguishable
-- from one that had always gone through the fixed createDepartment().
--
-- Scope rule (deliberately per-department, not per-status): a department is
-- touched ONLY if it currently has ZERO TicketStatus rows of ANY kind. A
-- department with even one existing status (starter or manually created)
-- is left completely untouched — this migration never adds, removes,
-- renames, or reorders a status for such a department. This is a stricter
-- rule than the WHERE-NOT-EXISTS-per-value pattern used by the
-- 20260729000000_add_priority_config_and_backfill precedent (which fills in
-- individually-missing enum rows); TicketStatus has no fixed enum of
-- required values, so "some rows already exist" must mean "an admin already
-- configured this department" and must never be reconciled against a
-- starter list.
--
-- Idempotent and safe on a database with no affected departments: the
-- INSERT ... SELECT ... WHERE NOT EXISTS pattern (same precedent as
-- 20260729000000_add_priority_config_and_backfill) only ever inserts for a
-- department that still has zero rows at the moment this runs; running this
-- exact statement again afterward (e.g. a duplicate deploy) inserts nothing,
-- because every previously-affected department now has real rows and no
-- longer matches WHERE NOT EXISTS.
--
-- id uses gen_random_uuid()::text (not Prisma's cuid(), which is a
-- client-side generator with no SQL equivalent) — TicketStatus.id is a
-- plain TEXT primary key with no format constraint, so a UUID string is a
-- valid, unique, permanent id here, consistent with the same precedent
-- migration's own choice for the same reason.
INSERT INTO "TicketStatus" ("id", "name", "color", "isDefault", "isClosed", "isActive", "order", "departmentId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, s.name, s.color, s."isDefault", s."isClosed", true, s."order", d.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Department" d
CROSS JOIN (VALUES
    ('Open', '#3b82f6', true, false, 1),
    ('In Progress', '#f59e0b', false, false, 2),
    ('Pending User', '#8b5cf6', false, false, 3),
    ('Resolved', '#10b981', false, false, 4),
    ('Closed', '#6b7280', false, true, 5),
    ('Cancelled', '#ef4444', false, true, 6)
) AS s(name, color, "isDefault", "isClosed", "order")
WHERE NOT EXISTS (
    SELECT 1 FROM "TicketStatus" existing WHERE existing."departmentId" = d."id"
);
