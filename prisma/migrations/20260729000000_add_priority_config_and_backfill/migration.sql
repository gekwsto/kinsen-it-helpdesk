-- Corrective migration, two parts:
--
-- 1. CreateTable ActivityPriorityConfig — department-scoped enablement +
--    display order for ActivityPriority, same precedent as
--    ActivityProgressConfig/ProjectStatusConfig/ActivityStatusConfig.
--
-- 2. Backfill: every EXISTING department gets a full, explicit row for
--    every ProjectStatus, every ActivityStatus, and every ActivityPriority.
--    This is the fix for the previous migration's real gap: application
--    code (lib/status-terminal.ts, lib/priority-config.ts) must NEVER fall
--    back to a hardcoded "COMPLETED/CANCELLED = terminal" or "URGENT..LOW"
--    assumption at read time — that's only safe if a real row always
--    exists to read. The specific isTerminal/sortOrder values inserted
--    here are a ONE-TIME, admin-overridable starting point (matching
--    lib/department-config-defaults.ts exactly), not a rule the app
--    re-derives from a status/priority's name afterwards.
--
-- Idempotent: every INSERT is a SELECT ... WHERE NOT EXISTS against the
-- real unique constraint, safe to run against a partially-seeded database
-- (e.g. one where createDepartment()'s own seeding already ran for a
-- department created after this migration was written but before it was
-- deployed).

-- CreateTable
CREATE TABLE "ActivityPriorityConfig" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "priority" "ActivityPriority" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityPriorityConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivityPriorityConfig_departmentId_priority_key" ON "ActivityPriorityConfig"("departmentId", "priority");

-- AddForeignKey
ALTER TABLE "ActivityPriorityConfig" ADD CONSTRAINT "ActivityPriorityConfig_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill ProjectStatusConfig for every existing department × every ProjectStatus
INSERT INTO "ProjectStatusConfig" ("id", "departmentId", "status", "isTerminal", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, d."id", s.status::"ProjectStatus", s."isTerminal", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Department" d
CROSS JOIN (VALUES
    ('PLANNING', false),
    ('IN_PROGRESS', false),
    ('ON_HOLD', false),
    ('COMPLETED', true),
    ('CANCELLED', true)
) AS s(status, "isTerminal")
WHERE NOT EXISTS (
    SELECT 1 FROM "ProjectStatusConfig" existing
    WHERE existing."departmentId" = d."id" AND existing."status" = s.status::"ProjectStatus"
);

-- Backfill ActivityStatusConfig for every existing department × every ActivityStatus
INSERT INTO "ActivityStatusConfig" ("id", "departmentId", "status", "isTerminal", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, d."id", s.status::"ActivityStatus", s."isTerminal", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Department" d
CROSS JOIN (VALUES
    ('TODO', false),
    ('IN_PROGRESS', false),
    ('ON_HOLD', false),
    ('BLOCKED', false),
    ('COMPLETED', true),
    ('CANCELLED', true)
) AS s(status, "isTerminal")
WHERE NOT EXISTS (
    SELECT 1 FROM "ActivityStatusConfig" existing
    WHERE existing."departmentId" = d."id" AND existing."status" = s.status::"ActivityStatus"
);

-- Backfill ActivityPriorityConfig for every existing department × every ActivityPriority
INSERT INTO "ActivityPriorityConfig" ("id", "departmentId", "priority", "sortOrder", "isEnabled", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, d."id", s.priority::"ActivityPriority", s."sortOrder", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Department" d
CROSS JOIN (VALUES
    ('URGENT', 0),
    ('HIGH', 1),
    ('MEDIUM', 2),
    ('LOW', 3)
) AS s(priority, "sortOrder")
WHERE NOT EXISTS (
    SELECT 1 FROM "ActivityPriorityConfig" existing
    WHERE existing."departmentId" = d."id" AND existing."priority" = s.priority::"ActivityPriority"
);
