-- backfill.sql — Phase 1 multi-department architecture.
--
-- NOT run automatically by `prisma migrate deploy` (kept separate from
-- migration.sql on purpose, so it's reviewable and independently rerunnable
-- rather than bundled into one all-or-nothing transactional migration).
-- Run this manually, AFTER migration.sql has been applied.
--
-- Safe to re-run: every step only touches rows that still need it (NULL
-- departmentId, or a membership row that doesn't exist yet).
--
-- This file was authored and schema-reviewed but has NOT been executed
-- against any database — no reachable Postgres instance was available in
-- the environment this was written in. See README.md in this folder for
-- the full run procedure and verification queries.

BEGIN;

-- ── 1. Default existing Ticket/Project/ProjectActivity rows to IT ─────────────
-- 'dept-it' is the bootstrap IT department created by prisma/seed.ts and is
-- present in every environment that has ever run the seed script. If your
-- environment uses a different id for the default department, adjust the
-- literal below before running.

UPDATE "Ticket"
SET "departmentId" = 'dept-it'
WHERE "departmentId" IS NULL;

UPDATE "Project"
SET "departmentId" = 'dept-it'
WHERE "departmentId" IS NULL;

-- Activities inherit their parent project's department where the project
-- has one; anything left over (standalone activities, or a project whose
-- own departmentId was still null) falls back to 'dept-it' like everything
-- else.
UPDATE "ProjectActivity" pa
SET "departmentId" = p."departmentId"
FROM "Project" p
WHERE pa."projectId" = p."id"
  AND pa."departmentId" IS NULL
  AND p."departmentId" IS NOT NULL;

UPDATE "ProjectActivity"
SET "departmentId" = 'dept-it'
WHERE "departmentId" IS NULL;

-- ── 2. One DepartmentMembership per existing user with a home department ──────
-- So nobody loses access on cutover without needing to log in again first.
-- Role mapping mirrors each user's existing global Role as closely as the
-- new DepartmentRole vocabulary allows:
--   Role.DEPARTMENT_MANAGER -> DepartmentRole.DEPARTMENT_MANAGER
--   Role.IT_AGENT           -> DepartmentRole.AGENT_ASSIGNEE
--   everything else (USER)  -> DepartmentRole.REQUESTER
-- Role.ADMIN users are skipped entirely: System Admins bypass department
-- membership checks everywhere (see requireDepartmentAccess in
-- lib/permissions.ts), so a membership row would be inert.
-- source = 'MANUAL' so this seed data is never touched/overwritten by the
-- Microsoft login-sync process later (see syncDepartmentMemberships).

INSERT INTO "DepartmentMembership"
  ("id", "userId", "departmentId", "role", "source", "isPrimary", "isActive", "createdAt", "updatedAt")
SELECT
  md5(u."id" || '-department-membership-backfill'),
  u."id",
  u."departmentId",
  CASE
    WHEN u."role" = 'DEPARTMENT_MANAGER' THEN 'DEPARTMENT_MANAGER'
    WHEN u."role" = 'IT_AGENT' THEN 'AGENT_ASSIGNEE'
    ELSE 'REQUESTER'
  END::"DepartmentRole",
  'MANUAL'::"MembershipSource",
  true,
  true,
  now(),
  now()
FROM "User" u
WHERE u."departmentId" IS NOT NULL
  AND u."role" != 'ADMIN'
  AND NOT EXISTS (
    SELECT 1 FROM "DepartmentMembership" dm
    WHERE dm."userId" = u."id" AND dm."departmentId" = u."departmentId"
  );

-- ── 3. Human-friendly slugs for the 5 known bootstrap departments ─────────────
-- Belt-and-suspenders on top of migration.sql's generic slugify step (which
-- would already have produced "it-department"/"human-resources"/etc). A
-- no-op if these ids don't exist in your environment.

UPDATE "Department" SET "slug" = 'it' WHERE "id" = 'dept-it';
UPDATE "Department" SET "slug" = 'hr' WHERE "id" = 'dept-hr';
UPDATE "Department" SET "slug" = 'finance' WHERE "id" = 'dept-finance';
UPDATE "Department" SET "slug" = 'sales' WHERE "id" = 'dept-sales';
UPDATE "Department" SET "slug" = 'operations' WHERE "id" = 'dept-operations';

COMMIT;

-- ── Verification — run these after and eyeball the counts ─────────────────────
-- SELECT count(*) FROM "Ticket" WHERE "departmentId" IS NULL;           -- expect 0
-- SELECT count(*) FROM "Project" WHERE "departmentId" IS NULL;          -- expect 0
-- SELECT count(*) FROM "ProjectActivity" WHERE "departmentId" IS NULL;  -- expect 0
-- SELECT "role", count(*) FROM "DepartmentMembership" GROUP BY "role";
-- SELECT "id", "slug" FROM "Department" ORDER BY "name";
