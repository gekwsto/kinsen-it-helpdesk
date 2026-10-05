-- Adds request-origin-only Project metadata (Expected Start/Finish,
-- Expected Total Initial Days, Expense Type, Budget, Estimated Cost, Actual
-- Cost, External) and the new global ProjectExpenseType reference list.
--
-- Fully additive and safe for every existing Project row: every new column
-- is nullable (or, for `external`, defaults to false — a safe "not
-- external" assumption, never a fabricated financial/date value) and
-- nothing populates the new money/date/expense-type columns retroactively.
-- Manual Projects, legacy Projects, and the OLD auto-created-on-approval
-- Projects from the previous iteration of this feature all simply have
-- NULL for these going forward — the mandatory-at-creation guarantee for a
-- NEW request-origin Project is enforced entirely at the application
-- boundary (createProjectFromApprovedRequest), never at the DB level.

-- CreateTable
CREATE TABLE "ProjectExpenseType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectExpenseType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectExpenseType_name_key" ON "ProjectExpenseType"("name");

-- AlterTable
ALTER TABLE "Project"
  ADD COLUMN "expectedStartDate" TIMESTAMP(3),
  ADD COLUMN "expectedFinishDate" TIMESTAMP(3),
  ADD COLUMN "expectedTotalInitialDays" INTEGER,
  ADD COLUMN "expenseTypeId" TEXT,
  ADD COLUMN "budget" DECIMAL(10,2),
  ADD COLUMN "estimatedCost" DECIMAL(10,2),
  ADD COLUMN "actualCost" DECIMAL(10,2),
  ADD COLUMN "external" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Project_expenseTypeId_idx" ON "Project"("expenseTypeId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_expenseTypeId_fkey" FOREIGN KEY ("expenseTypeId") REFERENCES "ProjectExpenseType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
