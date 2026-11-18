-- AlterTable
ALTER TABLE "TicketAttachment" ADD COLUMN "sourceAttachmentId" TEXT;

-- AlterTable
ALTER TABLE "PendingTicketAttachment" ADD COLUMN "sourceAttachmentId" TEXT;

-- AlterTable
ALTER TABLE "TicketHistory" ADD COLUMN "emailMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TicketHistory_emailMessageId_key" ON "TicketHistory"("emailMessageId");
