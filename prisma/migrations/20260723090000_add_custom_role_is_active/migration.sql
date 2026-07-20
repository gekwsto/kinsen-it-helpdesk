-- Disable lever for CustomRole (built-in roles can never be hard-deleted —
-- see lib/services/role-safety-service.ts — isActive is the only removal
-- lever for them; custom roles keep hard-delete when unused, and gain this
-- as an additional soft option). Fully additive: no column dropped, no
-- existing column's type/nullability changed, no data loss. Defaults every
-- existing row to true, matching current real-world state (nothing is
-- disabled today).

-- AlterTable
ALTER TABLE "CustomRole" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
