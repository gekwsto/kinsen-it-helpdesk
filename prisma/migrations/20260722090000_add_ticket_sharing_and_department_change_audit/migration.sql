-- Ticket-only sharing (shareWithDepartment/shareWithSubDepartment, both
-- default false so existing tickets are unaffected) and department-change
-- audit (departmentChangedById/At, denormalized alongside the existing
-- TicketHistory model whose DEPARTMENT_CHANGE enum value already existed
-- but was never written to). Fully additive: no column dropped, no existing
-- column's type/nullability changed, no data loss.

-- AlterTable: Ticket gains sharing flags + department-change audit columns
ALTER TABLE "Ticket" ADD COLUMN     "shareWithDepartment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shareWithSubDepartment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "departmentChangedById" TEXT,
ADD COLUMN     "departmentChangedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Ticket_shareWithDepartment_idx" ON "Ticket"("shareWithDepartment");

-- CreateIndex
CREATE INDEX "Ticket_shareWithSubDepartment_idx" ON "Ticket"("shareWithSubDepartment");

-- CreateIndex
CREATE INDEX "Ticket_departmentChangedById_idx" ON "Ticket"("departmentChangedById");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_departmentChangedById_fkey" FOREIGN KEY ("departmentChangedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
