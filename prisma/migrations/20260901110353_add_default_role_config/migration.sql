-- CreateTable
CREATE TABLE "DefaultRoleConfig" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "defaultGlobalCustomRoleId" TEXT,
    "defaultDepartmentCustomRoleId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DefaultRoleConfig_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "DefaultRoleConfig" ADD CONSTRAINT "DefaultRoleConfig_defaultGlobalCustomRoleId_fkey" FOREIGN KEY ("defaultGlobalCustomRoleId") REFERENCES "CustomRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefaultRoleConfig" ADD CONSTRAINT "DefaultRoleConfig_defaultDepartmentCustomRoleId_fkey" FOREIGN KEY ("defaultDepartmentCustomRoleId") REFERENCES "CustomRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
