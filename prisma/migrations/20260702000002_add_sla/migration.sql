-- CreateTable
CREATE TABLE "SlaSettings" (
    "id" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlaSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlaPolicy" (
    "id" TEXT NOT NULL,
    "priorityId" TEXT NOT NULL,
    "firstResponseHours" INTEGER NOT NULL DEFAULT 8,
    "resolutionHours" INTEGER NOT NULL DEFAULT 48,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlaPolicy_priorityId_key" ON "SlaPolicy"("priorityId");

-- AddForeignKey
ALTER TABLE "SlaPolicy" ADD CONSTRAINT "SlaPolicy_priorityId_fkey" FOREIGN KEY ("priorityId") REFERENCES "TicketPriority"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed default SlaSettings row
INSERT INTO "SlaSettings" ("id", "isEnabled", "updatedAt") VALUES ('sla-settings-singleton', false, NOW());
