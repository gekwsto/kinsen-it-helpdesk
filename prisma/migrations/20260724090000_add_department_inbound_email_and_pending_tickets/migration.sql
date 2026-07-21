-- Department Email -> Pending Tickets flow. Fully additive: no column
-- dropped, no existing column's type/nullability changed, no data loss.
-- Department.inboundEmail is a new nullable+unique column (defaults every
-- existing row to NULL, matching "not configured yet"). PendingTicket /
-- PendingTicketAttachment are brand-new tables — inbound email no longer
-- creates a Ticket directly; it creates a PendingTicket that only becomes a
-- real Ticket once accepted (see lib/services/pending-ticket-service.ts).

-- CreateEnum
CREATE TYPE "PendingTicketStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "Department" ADD COLUMN     "inboundEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Department_inboundEmail_key" ON "Department"("inboundEmail");

-- CreateTable
CREATE TABLE "PendingTicket" (
    "id" TEXT NOT NULL,
    "status" "PendingTicketStatus" NOT NULL DEFAULT 'PENDING',
    "emailMessageId" TEXT NOT NULL,
    "emailThreadId" TEXT,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,
    "requesterId" TEXT,
    "acceptedTicketId" TEXT,
    "acceptedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingTicket_emailMessageId_key" ON "PendingTicket"("emailMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingTicket_acceptedTicketId_key" ON "PendingTicket"("acceptedTicketId");

-- CreateIndex
CREATE INDEX "PendingTicket_departmentId_idx" ON "PendingTicket"("departmentId");

-- CreateIndex
CREATE INDEX "PendingTicket_status_idx" ON "PendingTicket"("status");

-- CreateIndex
CREATE INDEX "PendingTicket_requesterId_idx" ON "PendingTicket"("requesterId");

-- AddForeignKey
ALTER TABLE "PendingTicket" ADD CONSTRAINT "PendingTicket_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicket" ADD CONSTRAINT "PendingTicket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicket" ADD CONSTRAINT "PendingTicket_acceptedTicketId_fkey" FOREIGN KEY ("acceptedTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicket" ADD CONSTRAINT "PendingTicket_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingTicket" ADD CONSTRAINT "PendingTicket_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "PendingTicketAttachment" (
    "id" TEXT NOT NULL,
    "pendingTicketId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingTicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingTicketAttachment_pendingTicketId_idx" ON "PendingTicketAttachment"("pendingTicketId");

-- AddForeignKey
ALTER TABLE "PendingTicketAttachment" ADD CONSTRAINT "PendingTicketAttachment_pendingTicketId_fkey" FOREIGN KEY ("pendingTicketId") REFERENCES "PendingTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
