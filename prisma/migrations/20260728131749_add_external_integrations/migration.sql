-- AlterEnum
ALTER TYPE "TicketSource" ADD VALUE 'API';

-- DropForeignKey
ALTER TABLE "IntegrationApiKey" DROP CONSTRAINT "IntegrationApiKey_createdById_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationAuditLog" DROP CONSTRAINT "IntegrationAuditLog_apiKeyId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationIdempotencyRecord" DROP CONSTRAINT "IntegrationIdempotencyRecord_apiKeyId_fkey";

-- DropIndex
DROP INDEX "TicketMessage_emailMessageId_key";

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "externalMetadata" JSONB,
ADD COLUMN     "externalReferenceId" TEXT,
ADD COLUMN     "integrationId" TEXT,
ADD COLUMN     "sourceUrl" TEXT;

-- DropTable
DROP TABLE "IntegrationApiKey";

-- DropTable
DROP TABLE "IntegrationAuditLog";

-- DropTable
DROP TABLE "IntegrationIdempotencyRecord";

-- CreateTable
CREATE TABLE "ExternalIntegration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" TEXT NOT NULL,
    "defaultCategoryId" TEXT,
    "defaultPriorityId" TEXT,
    "baseUrl" TEXT,
    "apiKeyPrefix" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIntegration_slug_key" ON "ExternalIntegration"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIntegration_apiKeyPrefix_key" ON "ExternalIntegration"("apiKeyPrefix");

-- CreateIndex
CREATE INDEX "ExternalIntegration_departmentId_idx" ON "ExternalIntegration"("departmentId");

-- CreateIndex
CREATE INDEX "ExternalIntegration_isActive_idx" ON "ExternalIntegration"("isActive");

-- CreateIndex
CREATE INDEX "Ticket_integrationId_idx" ON "Ticket"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_integrationId_externalReferenceId_key" ON "Ticket"("integrationId", "externalReferenceId");

-- CreateIndex
CREATE INDEX "TicketMessage_emailMessageId_idx" ON "TicketMessage"("emailMessageId");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "ExternalIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_defaultCategoryId_fkey" FOREIGN KEY ("defaultCategoryId") REFERENCES "TicketCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_defaultPriorityId_fkey" FOREIGN KEY ("defaultPriorityId") REFERENCES "TicketPriority"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIntegration" ADD CONSTRAINT "ExternalIntegration_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

