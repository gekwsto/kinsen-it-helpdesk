-- Opt-in "New Department Tickets" notification preference
-- (lib/ticket-notification-service.ts's notifyDepartmentOfNewTicket).
-- Defaults to OFF (false) for both existing and new users, per spec —
-- unlike mentionRemindersEnabled, which defaults to true.
ALTER TABLE "User" ADD COLUMN "newDepartmentTicketsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Reuses the existing PushNotificationLog eventKey-unique claim table for
-- idempotent per-(ticket, user) delivery, the same mechanism REPLY/TERMINAL
-- push events already rely on.
ALTER TYPE "PushNotificationType" ADD VALUE 'DEPARTMENT_NEW_TICKET';
