-- CreateEnum
CREATE TYPE "DependencyType" AS ENUM ('FINISH_TO_START', 'START_TO_START', 'FINISH_TO_FINISH', 'START_TO_FINISH');

-- CreateTable
CREATE TABLE "ActivityDependency" (
    "id" TEXT NOT NULL,
    "predecessorId" TEXT NOT NULL,
    "successorId" TEXT NOT NULL,
    "type" "DependencyType" NOT NULL DEFAULT 'FINISH_TO_START',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityDependency_predecessorId_idx" ON "ActivityDependency"("predecessorId");

-- CreateIndex
CREATE INDEX "ActivityDependency_successorId_idx" ON "ActivityDependency"("successorId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityDependency_predecessorId_successorId_type_key" ON "ActivityDependency"("predecessorId", "successorId", "type");

-- AddForeignKey
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_predecessorId_fkey" FOREIGN KEY ("predecessorId") REFERENCES "ProjectActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_successorId_fkey" FOREIGN KEY ("successorId") REFERENCES "ProjectActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
