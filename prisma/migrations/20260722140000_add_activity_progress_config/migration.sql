-- CreateTable
CREATE TABLE "ActivityProgressConfig" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "status" "ActivityStatus" NOT NULL,
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActivityProgressConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivityProgressConfig_departmentId_status_key" ON "ActivityProgressConfig"("departmentId", "status");

-- AddForeignKey
ALTER TABLE "ActivityProgressConfig" ADD CONSTRAINT "ActivityProgressConfig_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
