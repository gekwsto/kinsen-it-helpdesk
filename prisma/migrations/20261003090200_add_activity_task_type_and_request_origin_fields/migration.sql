-- Request-origin-only Activity metadata (nullable — legacy Activities and
-- Activities under normal/manual Projects simply never have these set; the
-- "required at creation" rule is enforced in application code, never at the
-- DB level, exactly like Project's own expectedStartDate/expectedFinishDate).
-- AlterTable
ALTER TABLE "ProjectActivity" ADD COLUMN     "actualDays" INTEGER,
ADD COLUMN     "expectedDays" INTEGER,
ADD COLUMN     "expectedFinishDate" TIMESTAMP(3),
ADD COLUMN     "expectedStartDate" TIMESTAMP(3),
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "taskTypeCost" DECIMAL(10,2),
ADD COLUMN     "taskTypeId" TEXT;

-- Project Request Type cost is explicitly removed per this feature's own
-- requirement — this intentionally drops existing historical cost values on
-- both tables (ProjectRequestType.cost and its ProjectRequest.cost
-- submission-time snapshot). This is the one deliberately destructive change
-- in this migration; everything else here is purely additive.
-- AlterTable
ALTER TABLE "ProjectRequest" DROP COLUMN "cost";

-- AlterTable
ALTER TABLE "ProjectRequestType" DROP COLUMN "cost";

-- CreateTable
CREATE TABLE "ActivityTaskType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cost" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityTaskType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivityTaskType_name_key" ON "ActivityTaskType"("name");

-- CreateIndex
CREATE INDEX "ProjectActivity_ownerId_idx" ON "ProjectActivity"("ownerId");

-- CreateIndex
CREATE INDEX "ProjectActivity_taskTypeId_idx" ON "ProjectActivity"("taskTypeId");

-- AddForeignKey
ALTER TABLE "ProjectActivity" ADD CONSTRAINT "ProjectActivity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectActivity" ADD CONSTRAINT "ProjectActivity_taskTypeId_fkey" FOREIGN KEY ("taskTypeId") REFERENCES "ActivityTaskType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the new taskType.manage permission (GLOBAL — Task Types are global
-- reference data, same tier as user.manage/role.manage — see
-- GLOBAL_ONLY_PERMISSION_KEYS in app/api/admin/roles/[id]/permissions/[permId]/route.ts
-- and app/(main)/admin/roles/page.tsx, both updated alongside this
-- migration) and grant it to the built-in ADMIN role, the same idempotent
-- ON CONFLICT DO NOTHING pattern this repository already uses for every
-- other post-seed permission migration (e.g.
-- 20260929100000_add_category_create_permission). ADMIN's own grant row is
-- cosmetic-only (ADMIN bypasses hasPermission() unconditionally — see
-- lib/permissions.ts) but kept for /admin/roles matrix consistency, same as
-- every other ADMIN-only permission's own migration.
INSERT INTO "Permission" ("id", "key", "description", "module", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'taskType.manage', 'Create, edit, and delete Activity Task Types (global reference data)', 'admin', now(), now())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("roleKey", "permissionId", "createdAt")
SELECT 'ADMIN', p."id", now()
FROM "Permission" p
WHERE p."key" = 'taskType.manage'
ON CONFLICT ("roleKey", "permissionId") DO NOTHING;
