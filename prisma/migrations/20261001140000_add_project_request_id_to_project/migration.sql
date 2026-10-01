-- Adds the (nullable, unique) link from Project back to the ProjectRequest
-- it was auto-created from on final approval (see decideApproval in
-- lib/services/project-request-service.ts).
--
-- Fully additive and safe for every existing Project row: the new column
-- defaults to NULL and nothing populates it retroactively — a Project that
-- already exists today was created manually and simply has no originating
-- request, exactly as before this migration.
--
-- ON DELETE SET NULL (not CASCADE): a Project is a significant, independent
-- entity in its own right — deleting the paperwork that originated it must
-- never delete the Project itself.

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "projectRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Project_projectRequestId_key" ON "Project"("projectRequestId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_projectRequestId_fkey" FOREIGN KEY ("projectRequestId") REFERENCES "ProjectRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
