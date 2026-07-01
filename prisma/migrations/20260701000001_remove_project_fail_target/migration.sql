-- Migration: Remove failTarget from Project, remap Critical ticket priority to High,
--            and clamp project priority 4 → 3

-- Step 1: Remap existing tickets with Critical priority to High
UPDATE "Ticket"
SET "priorityId" = (SELECT id FROM "TicketPriority" WHERE name = 'High')
WHERE "priorityId" IN (SELECT id FROM "TicketPriority" WHERE name = 'Critical')
  AND EXISTS (SELECT 1 FROM "TicketPriority" WHERE name = 'High')
  AND EXISTS (SELECT 1 FROM "TicketPriority" WHERE name = 'Critical');

-- Step 2: Delete the Critical TicketPriority row
DELETE FROM "TicketPriority" WHERE name = 'Critical';

-- Step 3: Clamp project priority 4 to 3 (was "Critical", now max is "High")
UPDATE "Project" SET priority = 3 WHERE priority = 4;

-- Step 4: Drop the failTarget column from Project
ALTER TABLE "Project" DROP COLUMN IF EXISTS "failTarget";
