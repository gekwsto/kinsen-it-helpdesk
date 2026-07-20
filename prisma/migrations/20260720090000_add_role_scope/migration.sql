-- Adds RoleScope to CustomRole so /admin/roles can distinguish global roles
-- from DepartmentRole-backed rows (see lib/services/assignment-eligibility-service.ts
-- and the Department Roles tab). Additive: every existing CustomRole row
-- defaults to GLOBAL (its current, unchanged meaning); DEPARTMENT_MANAGER is
-- the one deliberately-shared roleKey between the global Role enum and the
-- DepartmentRole enum, so it becomes BOTH rather than staying GLOBAL.

CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'DEPARTMENT', 'BOTH');

ALTER TABLE "CustomRole" ADD COLUMN "scope" "RoleScope" NOT NULL DEFAULT 'GLOBAL';

UPDATE "CustomRole" SET "scope" = 'BOTH' WHERE "key" = 'DEPARTMENT_MANAGER';
