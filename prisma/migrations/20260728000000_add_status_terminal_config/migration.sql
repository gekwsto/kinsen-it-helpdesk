-- CreateTable
CREATE TABLE "ProjectStatusConfig" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL,
    "isTerminal" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectStatusConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityStatusConfig" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "status" "ActivityStatus" NOT NULL,
    "isTerminal" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityStatusConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectStatusConfig_departmentId_status_key" ON "ProjectStatusConfig"("departmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityStatusConfig_departmentId_status_key" ON "ActivityStatusConfig"("departmentId", "status");

-- AddForeignKey
ALTER TABLE "ProjectStatusConfig" ADD CONSTRAINT "ProjectStatusConfig_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityStatusConfig" ADD CONSTRAINT "ActivityStatusConfig_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No default rows are seeded here on purpose: an absent (departmentId, status)
-- row means "use the hardcoded default" (COMPLETED/CANCELLED = terminal),
-- resolved entirely in application code (lib/status-terminal.ts) — identical
-- to today's actual behavior for every existing department. This keeps the
-- migration additive/backward-compatible with zero data changes.
