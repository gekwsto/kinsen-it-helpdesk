import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { getProjectFeedbackEligibility } from "@/lib/services/project-feedback-service";
import { ProjectFeedbackCard } from "@/components/projects/project-feedback-card";

/**
 * The dedicated, standalone Project Feedback evaluation page — the ONLY
 * place the full five-rating Greek evaluation form is ever rendered (see
 * components/projects/project-feedback-card.tsx; the Project detail page
 * itself now shows only a small CTA linking here, never the form).
 *
 * Authorization is fully independent of the Project detail page's own
 * view-access rule — holding project.view, being a Member, Audience, an
 * additional entry in the `owners` multi-owner set, the original Project
 * Request requester, or ADMIN grants NOTHING here. Only Project.ownerId
 * (the single canonical primary Owner) may ever view or submit/update
 * feedback — see getProjectFeedbackEligibility/upsertProjectFeedback in
 * lib/services/project-feedback-service.ts, the single authoritative
 * source for this rule (POST /api/projects/[id]/feedback re-verifies the
 * identical check independently; this page's own gating below is for
 * render-time UX only, never the real authority).
 *
 * A non-owner (or a manual Project, where feedback never applies at all)
 * is redirected straight back to the Project detail page, which
 * independently re-derives whether THEY can even view that page.
 */
export default async function ProjectFeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      department: { select: { name: true } },
      expectedStartDate: true,
      expectedFinishDate: true,
      owners: { select: { id: true, name: true, email: true } },
    },
  });
  if (!project) notFound();

  const eligibility = await getProjectFeedbackEligibility(id, session.user.id);
  if (!eligibility.isRequestOriginTarget || !eligibility.isPrimaryOwner) {
    redirect(`/projects/${id}`);
  }

  const canEvaluate = eligibility.isProjectCompleted || eligibility.feedback !== null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/projects/${id}`} className="hover:text-foreground truncate max-w-[200px]">
          {project.title}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Αξιολόγηση</span>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Αξιολόγηση Έργου</h1>
        <p className="text-muted-foreground mt-1">Παρακαλούμε αξιολογήστε το ολοκληρωμένο έργο.</p>
      </div>

      {canEvaluate ? (
        <ProjectFeedbackCard
          projectId={project.id}
          isProjectCompleted={eligibility.isProjectCompleted}
          // Date is a class instance — cannot cross the Server -> Client
          // Component boundary as-is (same rule as Prisma.Decimal
          // elsewhere in this app); converted to an ISO string here.
          initialFeedback={
            eligibility.feedback
              ? {
                  deliverySpeedRating: eligibility.feedback.deliverySpeedRating,
                  communicationRating: eligibility.feedback.communicationRating,
                  functionalityRating: eligibility.feedback.functionalityRating,
                  easeOfUseRating: eligibility.feedback.easeOfUseRating,
                  overallRating: eligibility.feedback.overallRating,
                  requirementsDelivered: eligibility.feedback.requirementsDelivered,
                  comments: eligibility.feedback.comments,
                  createdAt: eligibility.feedback.createdAt.toISOString(),
                  updatedAt: eligibility.feedback.updatedAt.toISOString(),
                }
              : null
          }
          // Read-only "Σχετικό Έργο" section — existing Project data only,
          // never an editable control (no Activity management, Project
          // edit, Members, attachments, notes, financials, or status
          // actions anywhere on this page).
          projectSummary={{
            title: project.title,
            departmentName: project.department?.name ?? null,
            expectedStartDate: project.expectedStartDate ? project.expectedStartDate.toISOString() : null,
            expectedFinishDate: project.expectedFinishDate ? project.expectedFinishDate.toISOString() : null,
            owners: project.owners,
          }}
        />
      ) : (
        // Primary Owner, but the Project is NOT currently COMPLETED and no
        // feedback has ever been submitted — nothing to show or submit
        // yet (see spec case "Primary owner + non-completed + no
        // feedback"). Never a silent redirect loop; a clear explanation
        // plus a way back.
        <div className="rounded-lg border bg-muted/20 p-6 text-sm text-muted-foreground">
          Η αξιολόγηση δεν είναι διαθέσιμη αυτή τη στιγμή — το έργο δεν είναι ολοκληρωμένο.
          <div className="mt-3">
            <Link href={`/projects/${id}`} className="text-primary hover:underline">
              Επιστροφή στο έργο
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
