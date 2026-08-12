-- Backfill: ensure a canonical CustomRole row exists for every built-in
-- DepartmentRole enum value, independent of prisma/seed.ts ever having run
-- against this database. Production databases may never run `db seed`
-- again, so this guarantee must live in the migration history itself, not
-- only in the (dev-oriented) seed script.
--
-- Idempotent and additive:
--   - "ON CONFLICT (key) DO NOTHING" — if a row for this key already
--     exists (e.g. seed.ts already ran, or a prior run of this exact
--     migration), it is left completely untouched. This never overwrites
--     an administrator-renamed/redescribed built-in role — the whole point
--     is "create the canonical row only if it's genuinely missing."
--   - Values mirror prisma/seed.ts's `builtInRoles` DepartmentRole-scoped
--     entries exactly (including DEPARTMENT_MANAGER's own literal
--     description, distinct from lib/services/department-role-translation.ts's
--     DEPARTMENT_ROLE_DESCRIPTIONS.DEPARTMENT_MANAGER, since seed.ts
--     special-cases that one row as the scope=BOTH shared identity with the
--     global Role.DEPARTMENT_MANAGER value) so a freshly-backfilled row is
--     indistinguishable from one seed.ts would have created.
--   - No existing CustomRole row is ever updated or deleted by this
--     migration — a genuinely missing row is inserted; everything else is
--     left exactly as an administrator configured it.
INSERT INTO "CustomRole" (id, key, name, description, "isBuiltIn", "isActive", scope, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'DEPARTMENT_ADMIN', 'Department Admin', 'Full control of this department — projects, tickets, activities, goals, members and settings.', true, true, 'DEPARTMENT', now(), now()),
  (gen_random_uuid()::text, 'DEPARTMENT_MANAGER', 'Department Manager', 'Manage department projects and goals', true, true, 'BOTH', now(), now()),
  (gen_random_uuid()::text, 'PROJECT_MANAGER', 'Project Manager', 'Creates and edits projects and Gantt schedules for this department only.', true, true, 'DEPARTMENT', now(), now()),
  (gen_random_uuid()::text, 'AGENT_ASSIGNEE', 'Agent / Assignee', 'Handles assigned tickets and activities; sees every ticket in this department.', true, true, 'DEPARTMENT', now(), now()),
  (gen_random_uuid()::text, 'REQUESTER', 'Requester', 'Creates and tracks their own tickets in this department only.', true, true, 'DEPARTMENT', now(), now()),
  (gen_random_uuid()::text, 'VIEWER', 'Viewer', 'Read-only access to this department''s projects, tickets and activities.', true, true, 'DEPARTMENT', now(), now())
ON CONFLICT (key) DO NOTHING;
