-- Part A: MicrosoftDepartmentMapping gains an explicit departmentRole,
-- alongside the existing global `role` (kept, unrenamed). Added nullable,
-- backfilled from the existing role using the same translation table that
-- previously drove this at sync time (GLOBAL_ROLE_TO_DEPARTMENT_ROLE in
-- lib/services/department-role-translation.ts), then locked to NOT NULL —
-- every row is guaranteed a value by the UPDATE below before the constraint
-- is applied, so this is safe in one transaction. No data loss.
ALTER TABLE "MicrosoftDepartmentMapping" ADD COLUMN "departmentRole" "DepartmentRole";

UPDATE "MicrosoftDepartmentMapping"
SET "departmentRole" = CASE "role"
  WHEN 'ADMIN' THEN 'DEPARTMENT_ADMIN'
  WHEN 'DEPARTMENT_MANAGER' THEN 'DEPARTMENT_MANAGER'
  WHEN 'IT_AGENT' THEN 'AGENT_ASSIGNEE'
  WHEN 'DIRECTOR' THEN 'VIEWER'
  WHEN 'USER' THEN 'REQUESTER'
END::"DepartmentRole";

ALTER TABLE "MicrosoftDepartmentMapping" ALTER COLUMN "departmentRole" SET NOT NULL;

-- Part B: Priorities, Statuses, and Cancel Reasons become department-scopable,
-- mirroring TicketCategory's existing nullable-departmentId + global-fallback
-- pattern exactly. Existing rows keep departmentId = NULL (global, unchanged
-- visibility/behavior); the flat `name` unique constraint is replaced by a
-- compound (departmentId, name) one so two departments (or one department
-- and the global list) can each have their own "High"/"Open"/etc. No data
-- loss — only the uniqueness scope changes, and no existing rows can violate
-- it (all currently share departmentId = NULL, and the prior constraint
-- already guaranteed distinct names among them).
DROP INDEX "TicketCancelReason_name_key";
DROP INDEX "TicketPriority_name_key";
DROP INDEX "TicketStatus_name_key";

ALTER TABLE "TicketCancelReason" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "TicketPriority" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "TicketStatus" ADD COLUMN "departmentId" TEXT;

CREATE UNIQUE INDEX "TicketCancelReason_departmentId_name_key" ON "TicketCancelReason"("departmentId", "name");
CREATE UNIQUE INDEX "TicketPriority_departmentId_name_key" ON "TicketPriority"("departmentId", "name");
CREATE UNIQUE INDEX "TicketStatus_departmentId_name_key" ON "TicketStatus"("departmentId", "name");

ALTER TABLE "TicketPriority" ADD CONSTRAINT "TicketPriority_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketStatus" ADD CONSTRAINT "TicketStatus_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TicketCancelReason" ADD CONSTRAINT "TicketCancelReason_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
