-- CreateTable
CREATE TABLE "ActivityAttachment" (
    "id" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityAttachment_activityId_idx" ON "ActivityAttachment"("activityId");

-- AddForeignKey
ALTER TABLE "ActivityAttachment" ADD CONSTRAINT "ActivityAttachment_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "ProjectActivity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAttachment" ADD CONSTRAINT "ActivityAttachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
