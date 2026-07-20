-- Builds out SubDepartment (existed since the initial migration as a bare
-- name+departmentId FK, never given an admin UI/API/membership model) and
-- adds custom Department Role support (DepartmentMembership.customRoleId,
-- mirroring the existing User.customRoleId pattern). Fully additive: no
-- column dropped, no existing column's type/nullability changed, no data
-- loss. SubDepartment has never had a create UI/API, so in every real
-- deployment this table is empty — the new (departmentId, name) unique
-- index is added directly rather than via a defensive dedup step.

-- AlterTable: SubDepartment gains slug/description/isActive
ALTER TABLE "SubDepartment" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "SubDepartment_departmentId_idx" ON "SubDepartment"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SubDepartment_departmentId_name_key" ON "SubDepartment"("departmentId", "name");

-- CreateTable
CREATE TABLE "SubDepartmentMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subDepartmentId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "source" "MembershipSource" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubDepartmentMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubDepartmentMembership_subDepartmentId_idx" ON "SubDepartmentMembership"("subDepartmentId");

-- CreateIndex
CREATE INDEX "SubDepartmentMembership_userId_idx" ON "SubDepartmentMembership"("userId");

-- CreateIndex
CREATE INDEX "SubDepartmentMembership_departmentId_idx" ON "SubDepartmentMembership"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "SubDepartmentMembership_userId_subDepartmentId_key" ON "SubDepartmentMembership"("userId", "subDepartmentId");

-- AddForeignKey
ALTER TABLE "SubDepartmentMembership" ADD CONSTRAINT "SubDepartmentMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubDepartmentMembership" ADD CONSTRAINT "SubDepartmentMembership_subDepartmentId_fkey" FOREIGN KEY ("subDepartmentId") REFERENCES "SubDepartment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: Ticket/Project/ProjectActivity each gain an optional SubDepartment link
ALTER TABLE "Ticket" ADD COLUMN     "subDepartmentId" TEXT;

-- CreateIndex
CREATE INDEX "Ticket_subDepartmentId_idx" ON "Ticket"("subDepartmentId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_subDepartmentId_fkey" FOREIGN KEY ("subDepartmentId") REFERENCES "SubDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Project" ADD COLUMN     "subDepartmentId" TEXT;

-- CreateIndex
CREATE INDEX "Project_subDepartmentId_idx" ON "Project"("subDepartmentId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_subDepartmentId_fkey" FOREIGN KEY ("subDepartmentId") REFERENCES "SubDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ProjectActivity" ADD COLUMN     "subDepartmentId" TEXT;

-- CreateIndex
CREATE INDEX "ProjectActivity_subDepartmentId_idx" ON "ProjectActivity"("subDepartmentId");

-- AddForeignKey
ALTER TABLE "ProjectActivity" ADD CONSTRAINT "ProjectActivity_subDepartmentId_fkey" FOREIGN KEY ("subDepartmentId") REFERENCES "SubDepartment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: DepartmentMembership gains an optional custom-role override,
-- mirroring User.customRoleId — `role` stays required/unchanged so every
-- existing row and every enum-typed consumer keeps working untouched.
ALTER TABLE "DepartmentMembership" ADD COLUMN     "customRoleId" TEXT;

-- CreateIndex
CREATE INDEX "DepartmentMembership_customRoleId_idx" ON "DepartmentMembership"("customRoleId");

-- AddForeignKey
ALTER TABLE "DepartmentMembership" ADD CONSTRAINT "DepartmentMembership_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
