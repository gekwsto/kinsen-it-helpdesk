-- Department-scoped Activity Progress + SLA, three parts:
--
-- 1. ActivityProgressConfig gains isEnabled/sortOrder — full CRUD
--    (create/edit/disable/delete/reorder) per department via
--    /admin/activity-progress, instead of "always 6 fixed rows, only the
--    percentage editable".
--
-- 2. Backfill: every EXISTING department gets a full, explicit row for all
--    6 ActivityStatus values, using the exact same values the application
--    code's OWN hardcoded runtime fallback used to apply implicitly
--    (TODO=0, IN_PROGRESS=50, ON_HOLD=50, BLOCKED=50, COMPLETED=100,
--    CANCELLED=0 — see the previous lib/activities/activity-progress.ts).
--    This is the same fix as the earlier terminal-status/priority-config
--    migrations: application code (lib/activities/activity-progress.ts)
--    must never fall back to a hardcoded per-status-name guess at read
--    time — that's only safe once a real row always exists to read.
--    sortOrder for existing rows is backfilled to match the canonical
--    status order (TODO..CANCELLED) so today's display order is preserved.
--
-- 3. Backfill: every EXISTING TicketPriority gets an SlaPolicy row (8h/48h
--    — the same hardcoded fallback app/api/admin/sla/route.ts used to
--    apply implicitly), for the identical reason: SLA hours must resolve
--    from a real row, not a hardcoded literal repeated at every read site.
--
-- Idempotent: every INSERT is a SELECT ... WHERE NOT EXISTS against the
-- real unique constraint, safe to re-run.

-- AlterTable
ALTER TABLE "ActivityProgressConfig" ADD COLUMN "isEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ActivityProgressConfig" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "ActivityProgressConfig_departmentId_isEnabled_idx" ON "ActivityProgressConfig"("departmentId", "isEnabled");

-- Backfill sortOrder for rows that already existed before this migration,
-- matching the canonical ActivityStatus order.
UPDATE "ActivityProgressConfig" SET "sortOrder" = CASE "status"
    WHEN 'TODO' THEN 0
    WHEN 'IN_PROGRESS' THEN 1
    WHEN 'ON_HOLD' THEN 2
    WHEN 'BLOCKED' THEN 3
    WHEN 'COMPLETED' THEN 4
    WHEN 'CANCELLED' THEN 5
    ELSE 0
END;

-- Backfill ActivityProgressConfig for every existing department × every ActivityStatus
INSERT INTO "ActivityProgressConfig" ("id", "departmentId", "status", "progressPercent", "isEnabled", "sortOrder", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, d."id", s.status::"ActivityStatus", s."progressPercent", true, s."sortOrder", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Department" d
CROSS JOIN (VALUES
    ('TODO', 0, 0),
    ('IN_PROGRESS', 50, 1),
    ('ON_HOLD', 50, 2),
    ('BLOCKED', 50, 3),
    ('COMPLETED', 100, 4),
    ('CANCELLED', 0, 5)
) AS s(status, "progressPercent", "sortOrder")
WHERE NOT EXISTS (
    SELECT 1 FROM "ActivityProgressConfig" existing
    WHERE existing."departmentId" = d."id" AND existing."status" = s.status::"ActivityStatus"
);

-- Backfill SlaPolicy for every existing TicketPriority lacking one
INSERT INTO "SlaPolicy" ("id", "priorityId", "firstResponseHours", "resolutionHours", "updatedAt")
SELECT gen_random_uuid()::text, p."id", 8, 48, CURRENT_TIMESTAMP
FROM "TicketPriority" p
WHERE NOT EXISTS (
    SELECT 1 FROM "SlaPolicy" existing WHERE existing."priorityId" = p."id"
);
