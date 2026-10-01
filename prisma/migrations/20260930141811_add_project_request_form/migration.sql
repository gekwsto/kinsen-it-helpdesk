-- CreateEnum
CREATE TYPE "ProjectRequestStatus" AS ENUM ('PENDING_MANAGER_APPROVAL', 'PENDING_SYSTEM_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ProjectRequestType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRequestType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRequest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "importance" INTEGER NOT NULL,
    "projectTypeId" TEXT NOT NULL,
    "teamConcerned" TEXT NOT NULL,
    "expectedBenefits" TEXT NOT NULL,
    "businessAssessment" TEXT NOT NULL,
    "replacesExisting" BOOLEAN NOT NULL DEFAULT false,
    "requesterId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "status" "ProjectRequestStatus" NOT NULL DEFAULT 'PENDING_MANAGER_APPROVAL',
    "managerApproverId" TEXT NOT NULL,
    "managerApprovedAt" TIMESTAMP(3),
    "managerRejectedAt" TIMESTAMP(3),
    "managerComment" TEXT,
    "systemApproverId" TEXT,
    "systemApprovedAt" TIMESTAMP(3),
    "systemRejectedAt" TIMESTAMP(3),
    "systemComment" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRequestType_name_key" ON "ProjectRequestType"("name");

-- CreateIndex
CREATE INDEX "ProjectRequest_status_idx" ON "ProjectRequest"("status");

-- CreateIndex
CREATE INDEX "ProjectRequest_departmentId_idx" ON "ProjectRequest"("departmentId");

-- CreateIndex
CREATE INDEX "ProjectRequest_requesterId_idx" ON "ProjectRequest"("requesterId");

-- CreateIndex
CREATE INDEX "ProjectRequest_managerApproverId_idx" ON "ProjectRequest"("managerApproverId");

-- CreateIndex
CREATE INDEX "ProjectRequest_systemApproverId_idx" ON "ProjectRequest"("systemApproverId");

-- CreateIndex
CREATE INDEX "ProjectRequest_createdAt_idx" ON "ProjectRequest"("createdAt");

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_projectTypeId_fkey" FOREIGN KEY ("projectTypeId") REFERENCES "ProjectRequestType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_managerApproverId_fkey" FOREIGN KEY ("managerApproverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRequest" ADD CONSTRAINT "ProjectRequest_systemApproverId_fkey" FOREIGN KEY ("systemApproverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
