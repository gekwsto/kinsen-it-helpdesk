-- Ticket Resolution Time Tracking (manual effort, lib/resolution-time.ts).
--
-- * Ticket.resolutionTimeMinutes: nullable, NO default, NO backfill — every
--   existing/historical ticket keeps NULL ("not recorded"), distinct from an
--   explicitly recorded 0. The CHECK mirrors the server-side validation
--   (non-negative, at most 1000 working days = 480000 minutes).
-- * TicketHistoryType.RESOLUTION_TIME_CHANGE: audit entries for edits.
-- * ticket.resolutionTime.edit: dedicated, department-scoped permission for
--   standalone edits. Granted by default to the built-in roles that already
--   hold ticket.changeStatus (i.e. can resolve tickets): ADMIN (cosmetic —
--   ADMIN bypasses hasPermission), IT_AGENT, DEPARTMENT_ADMIN,
--   AGENT_ASSIGNEE. No custom role is touched; administrators grant/revoke
--   via /admin/roles. Idempotent (ON CONFLICT DO NOTHING).

ALTER TABLE "Ticket" ADD COLUMN "resolutionTimeMinutes" INTEGER;

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_resolutionTimeMinutes_range"
  CHECK ("resolutionTimeMinutes" IS NULL OR ("resolutionTimeMinutes" >= 0 AND "resolutionTimeMinutes" <= 480000));

ALTER TYPE "TicketHistoryType" ADD VALUE IF NOT EXISTS 'RESOLUTION_TIME_CHANGE';

INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES
(gen_random_uuid()::text, 'ticket.resolutionTime.edit', 'Edit a ticket''s recorded resolution time', 'tickets', now(), now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT r."roleKey", p."id", now()
FROM "Permission" p
CROSS JOIN (VALUES ('ADMIN'), ('IT_AGENT'), ('DEPARTMENT_ADMIN'), ('AGENT_ASSIGNEE')) AS r("roleKey")
WHERE p."key" = 'ticket.resolutionTime.edit'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
