import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ChevronRight, Calendar, Users, Target, Ticket, Pencil } from "lucide-react";
import { GoalStatus } from "@prisma/client";
import { formatTicketNumber } from "@/lib/utils";
import { ProjectActivitiesCard } from "@/components/projects/project-activities-card";
import { ProjectActivitySequenceCard } from "@/components/projects/project-activity-sequence-card";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { EntityNotes } from "@/components/notes/entity-notes";
import { EntityAttachments } from "@/components/attachments/entity-attachments";
import { EntityRelatedLinks } from "@/components/related-links/entity-related-links";
import { getRelatedLinksAccess, listRelatedLinksForPage } from "@/lib/services/related-links-service";
import { ProjectDetailHeader } from "@/components/projects/project-detail-header";
import { formatEUR } from "@/lib/currency";
import { computeProjectFinancials } from "@/lib/services/project-financials-service";
import { getProjectFeedbackEligibility } from "@/lib/services/project-feedback-service";
import { ProjectFeedbackCard } from "@/components/projects/project-feedback-card";
import { FolderKanban, Wallet } from "lucide-react";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true, email: true, image: true } },
      // Request-origin Projects only (always empty for a manual one except
      // `owners`, which always mirrors the single `owner` above — see both
      // relations' own schema doc comments) — rendered in the Project
      // Request Setup card below, never on a manual Project.
      owners: { select: { id: true, name: true, email: true, image: true } },
      audience: { select: { id: true, name: true, email: true, image: true } },
      department: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      members: { select: { id: true, name: true, email: true, image: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          assignedUsers: { select: { id: true, name: true, image: true } },
          owner: { select: { id: true, name: true, image: true } },
        },
      },
      yearlyGoals: { select: { id: true, year: true, status: true, targetValue: true, currentValue: true, unit: true } },
      expenseType: { select: { id: true, name: true, isActive: true } },
      projectRequest: { select: { id: true, title: true } },
    },
  });

  if (!project) notFound();

  // Department-scoped (global grant OR this Project's own Department
  // grant), OR — for a request-origin Project only — an explicitly-
  // selected Owner/Audience user, who may hold no Department permission
  // here at all (both are system-wide, see hasProjectViewAccess's own doc
  // comment). Still never grants project.edit/project.delete — those stay
  // exactly the Department-scoped checks below, completely untouched.
  const canView = await hasProjectViewAccess(session.user.id, session.user.role, session.user.customRoleId, project);
  if (!canView) redirect("/dashboard");

  // project.edit — computed server-side and passed down as a boolean, used
  // by BOTH the Notes composer's visibility AND the quick-status dropdown's
  // interactivity. In both cases this is only a UI convenience; POST
  // /api/projects/[id]/notes and PATCH /api/projects/[id] independently
  // re-check this same permission and are the actual authority.
  const canEditProject = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.edit");
  // Deliberately its OWN hasEffectiveEntityPermission call (never derived from
  // canEditProject above) — project.delete is a separate, independently-
  // grantable permission (see prisma/seed.ts — DEPARTMENT_ADMIN has both,
  // but they are not implied by each other), so edit access must never be
  // treated as delete access. DELETE /api/projects/[id] independently
  // re-checks this and is the actual authority; this is only a UI hint.
  const canDeleteProject = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.delete");
  // activity.edit for this Project's own department — the SAME canonical
  // permission every other Activity mutation already requires. Gates ONLY
  // whether the request-origin Activity sequence card's drag handles
  // render; PATCH /api/projects/[id]/activities/order independently
  // re-checks this exact permission and is the real authority.
  const canEditActivities = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "activity.edit");
  const notes = await prisma.projectNote.findMany({
    where: { projectId: id },
    include: {
      author: { select: { id: true, name: true, email: true, image: true } },
      mentions: { include: { user: { select: { id: true, name: true, email: true } } } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Attachments: view/download follows the page's own project.view gate
  // above; upload/delete visibility comes from the SAME canEditProject
  // (project.edit) computed above — POST/DELETE
  // /api/projects/[id]/attachments[/...] independently re-check this and
  // are the actual authority. Same shape as ActivityAttachments' own query.
  const attachments = await prisma.projectAttachment.findMany({
    where: { projectId: id },
    include: { uploadedBy: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  });

  // Related Links: viewing follows the page's own project.view gate above;
  // Add/Edit/Delete visibility comes from the SAME effective project.edit
  // check (global grant OR this project's own department grant) the
  // /api/projects/[id]/related-links routes independently re-enforce.
  const relatedLinksAccess = await getRelatedLinksAccess(
    { id: session.user.id, role: session.user.role, customRoleId: session.user.customRoleId },
    "project",
    id
  );
  const relatedLinks = await listRelatedLinksForPage("project", id);

  const activityIds = project.activities.map((a) => a.id);

  const relatedTickets = await prisma.ticket.findMany({
    where: {
      OR: [
        { projectId: id },
        ...(activityIds.length > 0 ? [{ activityId: { in: activityIds } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      status: { select: { id: true, name: true, color: true } },
      requester: { select: { id: true, name: true } },
    },
  });

  const activityStatusDisplayConfigs = await getActivityStatusDisplayConfigsForDepartments(
    project.activities.map((a) => a.departmentId).filter((d): d is string => !!d)
  );
  const progressIsCalculated = relatedTickets.length > 0;

  // The SAME single authoritative aggregation every other reader of these
  // totals uses (GET/PATCH /api/projects/[id], the edit page) — Project
  // Estimated/Actual Cost no longer exist as stored columns at all; they're
  // derived fresh, here, from this Project's own currently-loaded
  // Activities (already carrying taskTypeCost/expectedDays/actualDays via
  // the `include` above, no extra query). Harmless to compute even for a
  // manual Project (naturally €0, since a manual Activity never has
  // taskTypeCost set) — only ever RENDERED inside the projectRequest-gated
  // card below.
  const { estimatedCost: projectEstimatedCost, actualCost: projectActualCost } = computeProjectFinancials(project.activities);

  // Project Feedback eligibility — the SAME authoritative check POST
  // /api/projects/[id]/feedback independently re-verifies at submit time
  // (see lib/services/project-feedback-service.ts); this is only ever used
  // to decide what the page renders (Case A/B/C/D), never trusted as
  // authorization by itself. Skipped entirely for a manual Project
  // (project.projectRequest is null) — the feature never even queries for
  // one, let alone shows it.
  const feedbackEligibility = project.projectRequest
    ? await getProjectFeedbackEligibility(project.id, session.user.id)
    : null;

  // Pre-resolved server-side (statusLabel/statusColor) so the client card
  // below never needs to ship/re-implement the department-scoped status
  // resolution logic — same values the old server-rendered row used.
  const activityRows = project.activities.map((activity) => {
    const statusDisplay = resolveActivityStatusDisplay(activityStatusDisplayConfigs, activity.departmentId, activity.status);
    return {
      id: activity.id,
      title: activity.title,
      dueDate: activity.dueDate ? activity.dueDate.toISOString() : null,
      isCompleted: activity.isCompleted,
      statusLabel: statusDisplay.label,
      statusColor: statusDisplay.color,
      assignedUsers: activity.assignedUsers,
    };
  });

  // Request-origin Projects only — sequence is the PRIMARY display order
  // (never silently overridden by createdAt/title/priority/status); a
  // deterministic (sequence ASC NULLS LAST, createdAt ASC, id ASC)
  // fallback only ever matters for a legacy/tied/null row, which the
  // backfill migration + create/reorder/delete/move paths keep from
  // normally occurring at all. Computed here (sorting the SAME
  // project.activities already loaded above, no extra query) only when
  // actually needed.
  const activitySequenceRows = project.projectRequest
    ? [...project.activities]
        .sort((a, b) => {
          const aSeq = a.sequence ?? Number.MAX_SAFE_INTEGER;
          const bSeq = b.sequence ?? Number.MAX_SAFE_INTEGER;
          if (aSeq !== bSeq) return aSeq - bSeq;
          if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() - b.createdAt.getTime();
          return a.id.localeCompare(b.id);
        })
        .map((activity) => {
          const statusDisplay = resolveActivityStatusDisplay(activityStatusDisplayConfigs, activity.departmentId, activity.status);
          return {
            id: activity.id,
            title: activity.title,
            dueDate: activity.dueDate ? activity.dueDate.toISOString() : null,
            isCompleted: activity.isCompleted,
            statusLabel: statusDisplay.label,
            statusColor: statusDisplay.color,
            owner: activity.owner,
            assignedUsers: activity.assignedUsers,
          };
        })
    : null;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">
          Projects
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{project.title}</span>
      </div>

      {/* Header */}
      <ProjectDetailHeader
        projectId={project.id}
        title={project.title}
        description={project.description}
        initialStatus={project.status}
        isGoal={project.isGoal}
        canEditProject={canEditProject}
        canDeleteProject={canDeleteProject}
      />

      {/* Project Details sits beside Project Request Setup as peer cards —
          `sm:grid-cols-2` only applies when both exist (project.projectRequest
          is set); a manual Project has no second card and no grid at all, so
          Project Details keeps occupying the row naturally instead of
          leaving an empty column beside it. */}
      <div className={project.projectRequest ? "grid gap-6 sm:grid-cols-2" : undefined}>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Project Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Owner</p>
              <div className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarImage src={project.owner.image ?? undefined} />
                  <AvatarFallback className="text-[9px]">
                    {getInitials(project.owner.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium">{project.owner.name}</span>
              </div>
            </div>

            {(project.startDate || project.endDate) && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> Timeline
                  </p>
                  <div className="text-sm">
                    {project.startDate && (
                      <p>Start: {formatDate(project.startDate)}</p>
                    )}
                    {project.endDate && (
                      <p>End: {formatDate(project.endDate)}</p>
                    )}
                  </div>
                </div>
              </>
            )}

            {project.department && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Department</p>
                  <p className="font-medium">{project.department.name}</p>
                </div>
              </>
            )}

            {project.members.length > 0 && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                    <Users className="h-3 w-3" /> Members
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {project.members.map((m) => (
                      <div key={m.id} className="flex items-center gap-1.5 text-xs">
                        <Avatar className="h-5 w-5">
                          <AvatarImage src={m.image ?? undefined} />
                          <AvatarFallback className="text-[9px]">
                            {getInitials(m.name)}
                          </AvatarFallback>
                        </Avatar>
                        {m.name}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Request-origin-only metadata — only ever rendered for a
            Project created through the request-origin setup flow
            (projectRequest is non-null exactly then). A manually-created
            Project never shows this section at all, never an empty
            version of it. */}
        {project.projectRequest && (
          <Card>
            {/* Same title-left/action-right CardHeader pattern already used
                by ProjectActivitiesCard — title wraps/truncates naturally
                and the button can wrap onto its own line via flex-wrap, so
                a narrow card never overflows horizontally. */}
            <CardHeader className="pb-3 flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Wallet className="h-4 w-4" />
                Project Request Setup
              </CardTitle>
              {/* Same small ghost pencil-icon pattern already used for
                  inline editing elsewhere on this page (see
                  components/related-links/entity-related-links.tsx) —
                  gated on the SAME canEditProject (project.edit) the rest
                  of this page already computed; no new permission.
                  Navigates to the existing Project edit page — there is no
                  second edit flow. */}
              {canEditProject && (
                <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" aria-label="Edit Project Request Setup">
                  <Link href={`/projects/${project.id}/edit`}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Edit
                  </Link>
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground mb-1">From Project Request</p>
                <Link href={`/project-requests/${project.projectRequest.id}`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
                  <FolderKanban className="h-3.5 w-3.5" />
                  {project.projectRequest.title}
                </Link>
              </div>

              {/* Owner(s) — the authoritative full set (project.owners),
                  never just the single canonical project.owner — a
                  request-origin Project's real owner set may have more
                  than one explicitly-selected user. Distinct from Members
                  below: an Owner is never implicitly a Member. */}
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                  <Users className="h-3 w-3" /> Owner{project.owners.length === 1 ? "" : "(s)"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {project.owners.map((o) => (
                    <div key={o.id} className="flex items-center gap-1.5 text-xs">
                      <Avatar className="h-5 w-5">
                        <AvatarImage src={o.image ?? undefined} />
                        <AvatarFallback className="text-[9px]">{getInitials(o.name)}</AvatarFallback>
                      </Avatar>
                      {o.name}
                    </div>
                  ))}
                </div>
              </div>

              {/* Audience — optional, zero or more; distinct from both
                  Owner(s) above and Members below. Only ever rendered when
                  non-empty, same "no empty placeholder" convention Members
                  already uses. */}
              {project.audience.length > 0 && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                      <Users className="h-3 w-3" /> Audience
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {project.audience.map((a) => (
                        <div key={a.id} className="flex items-center gap-1.5 text-xs">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={a.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">{getInitials(a.name)}</AvatarFallback>
                          </Avatar>
                          {a.name}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {(project.expectedStartDate || project.expectedFinishDate) && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Expected Timeline</p>
                    {project.expectedStartDate && <p>Start: {formatDate(project.expectedStartDate)}</p>}
                    {project.expectedFinishDate && <p>Finish: {formatDate(project.expectedFinishDate)}</p>}
                    {project.expectedTotalInitialDays !== null && (
                      <p className="text-xs text-muted-foreground mt-0.5">Initial baseline: {project.expectedTotalInitialDays} day(s)</p>
                    )}
                  </div>
                </>
              )}

              {project.expenseType && (
                <>
                  <Separator />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Expense Type</p>
                    <p className="font-medium">
                      {project.expenseType.name}
                      {!project.expenseType.isActive && <span className="text-muted-foreground font-normal"> (inactive)</span>}
                    </p>
                  </div>
                </>
              )}

              <Separator />
              <div className="grid grid-cols-2 gap-3">
                {/* Derived from this Project's own Activities (taskTypeCost
                    × expectedDays/actualDays, summed) — never a stored,
                    manually-entered value. Budget was removed entirely (no
                    replacement). */}
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Estimated Cost</p>
                  <p className="font-medium">{formatEUR(Number(projectEstimatedCost))}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Actual Cost</p>
                  <p className="font-medium">{formatEUR(Number(projectActualCost))}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">External</p>
                  <p className="font-medium">{project.external ? "Yes" : "No"}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Project Feedback — ONLY ever rendered for a request-origin
          Project (feedbackEligibility is null for a manual one), and even
          then only once the viewer is confirmed to be the original
          requester (Case D in this feature's own spec: anyone else simply
          never sees this card, full stop — there is no admin-review
          variant of it on this page at all; that lives at Administration
          -> Feedback instead). Before completion (Case A), nothing is
          rendered — never an empty/disabled placeholder card. */}
      {feedbackEligibility?.isOriginalRequester && (feedbackEligibility.isProjectCompleted || feedbackEligibility.feedback) && (
        <ProjectFeedbackCard
          projectId={project.id}
          // Date is a class instance — cannot cross the Server -> Client
          // Component boundary as-is (same rule as Prisma.Decimal
          // elsewhere on this page); converted to an ISO string here.
          initialFeedback={
            feedbackEligibility.feedback
              ? {
                  satisfactionScore: feedbackEligibility.feedback.satisfactionScore,
                  comments: feedbackEligibility.feedback.comments,
                  createdAt: feedbackEligibility.feedback.createdAt.toISOString(),
                }
              : null
          }
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Activities */}
        <div className="lg:col-span-2 space-y-4">
          {activitySequenceRows ? (
            <ProjectActivitySequenceCard
              projectId={project.id}
              initialActivities={activitySequenceRows}
              initialProgress={project.progress}
              progressIsCalculated={progressIsCalculated}
              canReorder={canEditActivities}
            />
          ) : (
            <ProjectActivitiesCard
              projectId={project.id}
              initialActivities={activityRows}
              initialProgress={project.progress}
              progressIsCalculated={progressIsCalculated}
            />
          )}

          <EntityAttachments
            apiBasePath={`/api/projects/${project.id}`}
            initialAttachments={attachments.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
            canManage={canEditProject}
          />

          <EntityNotes
            apiBasePath={`/api/projects/${project.id}`}
            initialNotes={notes.map((n) => ({
              ...n,
              createdAt: n.createdAt.toISOString(),
              mentions: n.mentions.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email })),
            }))}
            canAddNote={canEditProject}
            entityType="project"
            entityId={project.id}
          />

          <EntityRelatedLinks
            entityType="project"
            entityId={project.id}
            initialLinks={relatedLinks}
            initialCanManage={relatedLinksAccess?.canManage ?? false}
          />
        </div>

        {/* Related Tickets */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Ticket className="h-4 w-4" />
              Related Tickets ({relatedTickets.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {relatedTickets.length === 0 ? (
              <p className="text-center text-muted-foreground py-4 text-sm">
                No tickets linked to this project.
              </p>
            ) : (
              <div className="space-y-2">
                {relatedTickets.map((t) => (
                  <Link
                    key={t.id}
                    href={`/tickets/${t.id}`}
                    className="flex items-center justify-between p-2.5 rounded-lg border hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs text-muted-foreground shrink-0">
                        {formatTicketNumber(t.ticketNumber)}
                      </span>
                      <span className="text-sm font-medium truncate">{t.title}</span>
                    </div>
                    <span
                      className="text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2"
                      style={{
                        backgroundColor: t.status.color + "22",
                        color: t.status.color,
                      }}
                    >
                      {t.status.name}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Sidebar */}
        <div className="space-y-4">
          {project.successTarget && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Success Target
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p className="text-muted-foreground">{project.successTarget}</p>
              </CardContent>
            </Card>
          )}

          {project.yearlyGoals.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Linked Goals ({project.yearlyGoals.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {project.yearlyGoals.map((goal) => {
                  const GOAL_STATUS_COLORS: Record<GoalStatus, string> = {
                    NOT_STARTED: "bg-gray-100 text-gray-700",
                    IN_PROGRESS: "bg-blue-100 text-blue-700",
                    ON_TRACK: "bg-green-100 text-green-700",
                    AT_RISK: "bg-orange-100 text-orange-700",
                    COMPLETED: "bg-emerald-100 text-emerald-700",
                    CANCELLED: "bg-gray-100 text-gray-500",
                  };
                  return (
                    <Link
                      key={goal.id}
                      href={`/goals/${goal.id}`}
                      className="flex items-center justify-between p-2 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <span className="text-sm font-medium">{goal.year}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${GOAL_STATUS_COLORS[goal.status]}`}>
                        {goal.status.replace(/_/g, " ")}
                      </span>
                    </Link>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
