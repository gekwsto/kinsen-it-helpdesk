-- MicrosoftDepartmentMapping.role changes from DepartmentRole (department-
-- scoped) to Role (global) — so the "Role granted" field in a Microsoft
-- mapping stores exactly the same role concept as /admin/roles and
-- User.role, instead of a different, department-scoped enum.
--
-- Chosen over adding a parallel `globalRole` column: this table is small
-- (admin-configured mappings, not user content) and no other table
-- references this column's type, so a direct column-type change is safe and
-- avoids leaving a permanently dual-field table needing a later cleanup.
--
-- Existing rows are backfilled via the SAME judgment calls already encoded
-- in the (now-removed) translateDepartmentRoleToGlobalRole helper:
--   DEPARTMENT_ADMIN, DEPARTMENT_MANAGER -> DEPARTMENT_MANAGER
--   PROJECT_MANAGER, AGENT_ASSIGNEE      -> IT_AGENT
--   REQUESTER, VIEWER                    -> USER
-- No existing DepartmentRole value ever produced ADMIN, so there is no
-- forbidden-role data to reconcile.

ALTER TABLE "MicrosoftDepartmentMapping" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "MicrosoftDepartmentMapping"
  ALTER COLUMN "role" TYPE "Role"
  USING (
    CASE "role"::text
      WHEN 'DEPARTMENT_ADMIN' THEN 'DEPARTMENT_MANAGER'
      WHEN 'DEPARTMENT_MANAGER' THEN 'DEPARTMENT_MANAGER'
      WHEN 'PROJECT_MANAGER' THEN 'IT_AGENT'
      WHEN 'AGENT_ASSIGNEE' THEN 'IT_AGENT'
      WHEN 'REQUESTER' THEN 'USER'
      WHEN 'VIEWER' THEN 'USER'
    END
  )::"Role";

ALTER TABLE "MicrosoftDepartmentMapping" ALTER COLUMN "role" SET DEFAULT 'USER';
