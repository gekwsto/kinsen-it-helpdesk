-- ============================================================================
-- Data Migration: Remove Critical Ticket Priority & Map Project Priority 4→3
-- Run this script BEFORE running `npx prisma migrate dev`
-- ============================================================================

-- Step 1: Re-assign all tickets with "Critical" priority to "High"
UPDATE "Ticket"
SET "priorityId" = (SELECT id FROM "TicketPriority" WHERE name = 'High')
WHERE "priorityId" = (SELECT id FROM "TicketPriority" WHERE name = 'Critical')
  AND EXISTS (SELECT 1 FROM "TicketPriority" WHERE name = 'High')
  AND EXISTS (SELECT 1 FROM "TicketPriority" WHERE name = 'Critical');

-- Step 2: Delete the Critical priority row (safe — no tickets reference it after step 1)
DELETE FROM "TicketPriority" WHERE name = 'Critical';

-- Step 3: Map project priority value 4 (Critical) to 3 (High)
UPDATE "Project" SET priority = 3 WHERE priority = 4;

-- Verify
SELECT name, level FROM "TicketPriority" ORDER BY level DESC;
