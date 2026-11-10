import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ChevronRight, Calendar, Users, Target } from "lucide-react";
import { GoalStatus } from "@prisma/client";
import { ProjectActivitiesCard } from "@/components/projects/project-activities-card";
import { ProjectActivitySequenceCard } from "@/components/projects/project-activity-sequence-card";
import { ProjectRelatedTicketsCard } from "@/components/projects/project-related-tickets-card";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { EntityNotes } from "@/components/notes/entity-notes";
import { EntityAttachments } from "@/components/attachments/entity-attachments";
import { EntityRelatedLinks } from "@/components/related-links/entity-related-links";
import { getRelatedLinksAccess, listRelatedLinksForPage } from "@/lib/services/related-links-service";
import { ProjectDetailHeader } from "@/components/projects/project-detail-header";
import { formatEUR } from "@/lib/currency";
import { computeProjectFinancials } from "@/lib/services/project-financials-service";
import { getProjectFeedbackEligibility } from "@/lib/services/project-feedback-service";
import { ProjectFeedbackCtaCard } from "@/components/projects/project-feedback-cta-card";
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
  // ticket.linkProjectActivity for this Project's own department — the
  // SAME permission PATCH /api/tickets/[id] itself requires to set a
  // Ticket's projectId (see components/tickets/ticket-actions.tsx's own
  // "Link Project / Activity" dialog, which already gates on this).
  // Gates ONLY whether the new "Link Ticket" button renders here; the
  // route is the real authority regardless.
  const canLinkTickets = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "ticket.linkProjectActivity");
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
  // Activities (already carrying taskSubTypeCost/expectedDays/actualDays via
  // the `include` above, no extra query). Harmless to compute even for a
  // manual Project (naturally €0, since a manual Activity never has
  // taskSubTypeCost set) — only ever RENDERED inside the projectRequest-gated
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
      expectedStartDate: activity.expectedStartDate ? activity.expectedStartDate.toISOString() : null,
      expectedFinishDate: activity.expectedFinishDate ? activity.expectedFinishDate.toISOString() : null,
      startDate: activity.startDate ? activity.startDate.toISOString() : null,
      completedAt: activity.completedAt ? activity.completedAt.toISOString() : null,
      expectedDays: activity.expectedDays,
      actualDays: activity.actualDays,
      isCompleted: activity.isCompleted,
      statusLabel: statusDisplay.label,
      statusColor: statusDisplay.color,
      owner: activity.owner,
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
  // Owner(s) to render in the unified "People" section — `project.owners`
  // is the authoritative full set and, per its own schema doc comment,
  // ALWAYS contains `project.owner` (ownerId) for every Project, manual or
  // request-origin alike. Rendering owners[] alone (instead of the single
  // `owner` AND the separate `owners[]` list the two old cards each showed)
  // is what eliminates the duplicate-Owner display — nothing is lost,
  // since owners[] is a superset by invariant. The `project.owner` fallback
  // only guards against owners[] somehow coming back empty (it never
  // should, per the invariant) so a People section is never left ownerless.
  const ownersToShow = project.owners.length > 0 ? project.owners : [project.owner];

  const hasGeneralInfo = !!project.department || !!project.projectRequest;
  const hasTimeline =
    !!project.startDate ||
    !!project.endDate ||
    !!(project.projectRequest && (project.expectedStartDate || project.expectedFinishDate));

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
            expectedStartDate: activity.expectedStartDate ? activity.expectedStartDate.toISOString() : null,
            expectedFinishDate: activity.expectedFinishDate ? activity.expectedFinishDate.toISOString() : null,
            startDate: activity.startDate ? activity.startDate.toISOString() : null,
            completedAt: activity.completedAt ? activity.completedAt.toISOString() : null,
            expectedDays: activity.expectedDays,
            actualDays: activity.actualDays,
            isCompleted: activity.isCompleted,
            statusLabel: statusDisplay.label,
            statusColor: statusDisplay.color,
            owner: activity.owner,
            assignedUsers: activity.assignedUsers,
          };
        })
    : null;

  return (
    // No max-width cap (previously max-w-5xl, then max-w-7xl) — a fixed
    // Tailwind cap always clamps at SOME fixed px value, which is exactly
    // the thing that kept wasting space on anything wider than it (1280px
    // at max-w-7xl: measured 336px of unused width at a 1920px viewport,
    // 976px at 2560px). This way the page always fills whatever <main>
    // actually gives it (page padding is <main>'s own p-4 sm:p-6 in
    // app/(main)/layout.tsx, untouched here) — the bottom grid's own
    // lg:grid-cols-3 (Activities + a right-hand rail of Related Tickets/
    // Success Target/Linked Goals) distributes that width proportionally
    // on its own, nothing here needs to pre-guess a cap for it.
    <div className="space-y-6">
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

      {/* Project Overview + Related Tickets (plus Success Target/Linked
          Goals, grouped with Related Tickets exactly as before) side by
          side on wide screens — Overview taking the larger share
          (lg:col-span-2 of 3), reusing the SAME lg:grid-cols-3 +
          lg:col-span-2/1 ratio Activities/rail already used below this
          (now removed) grid, rather than inventing a new one. Below
          lg: (tablet and mobile) this single implicit column stacks the
          two in DOM order — Overview, then the Related Tickets group —
          exactly the required "Overview → Related Tickets → Activities"
          order once Activities (now its own full-width block further
          down the page) follows. */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {/* Project Overview — a single card replacing the old
              "Project Details" + "Project Request Setup" side-by-side pair.
              Four labeled sections (General Information / People / Timeline /
              Financial Information), each section's own responsive grid (1
              col on mobile, up to 4 on desktop depending on the section's
              own real field count) rather than the page choosing between two
              fixed-width cards. Request-origin-only fields (Project Request
              link, Expense Type, Audience, Expected Timeline, Financial
              Information) still only ever render when project.projectRequest
              is set — identical gating to the two old cards, just inside one
              container instead of a second Card. No separate Edit control
              here: the page's own top-level Edit button (ProjectDetailHeader,
              above) already links to this exact same /projects/[id]/edit
              route, so a card-local pencil button would be a second entry
              point to the identical flow. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Project Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
            {hasGeneralInfo && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">General Information</p>
                {/* Never more than 2 real fields here (Department, From Project
                    Request) now that Expense Type moved into Financial
                    Information below — sm:grid-cols-2 alone keeps this
                    balanced instead of reserving an all-but-always-empty 3rd
                    desktop column. */}
                <div className="grid gap-3 sm:grid-cols-2">
                  {project.department && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Department</p>
                      <p className="font-medium">{project.department.name}</p>
                    </div>
                  )}
                  {project.projectRequest && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">From Project Request</p>
                      <Link href={`/project-requests/${project.projectRequest.id}`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
                        <FolderKanban className="h-3.5 w-3.5" />
                        {project.projectRequest.title}
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* People — always at least an Owner (every Project has one; see
                ownersToShow's own doc comment above), Members/Audience only
                when non-empty. */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">People</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Users className="h-3 w-3" /> Owner{ownersToShow.length === 1 ? "" : "(s)"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ownersToShow.map((o) => (
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

                {project.members.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Users className="h-3 w-3" /> Members
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.members.map((m) => (
                        <div key={m.id} className="flex items-center gap-1.5 text-xs">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={m.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">{getInitials(m.name)}</AvatarFallback>
                          </Avatar>
                          {m.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Audience — request-origin only, zero or more; distinct
                    from both Owner(s) and Members. Only rendered when
                    non-empty, same "no empty placeholder" convention as
                    Members. */}
                {project.projectRequest && project.audience.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Users className="h-3 w-3" /> Audience
                    </p>
                    <div className="flex flex-wrap gap-1.5">
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
                )}
              </div>
            </div>

            {hasTimeline && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Timeline
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(project.startDate || project.endDate) && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Actual Timeline</p>
                      {project.startDate && <p>Start: {formatDate(project.startDate)}</p>}
                      {project.endDate && <p>End: {formatDate(project.endDate)}</p>}
                    </div>
                  )}
                  {project.projectRequest && (project.expectedStartDate || project.expectedFinishDate) && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Expected Timeline</p>
                      {project.expectedStartDate && <p>Start: {formatDate(project.expectedStartDate)}</p>}
                      {project.expectedFinishDate && <p>Finish: {formatDate(project.expectedFinishDate)}</p>}
                      {project.expectedTotalInitialDays !== null && (
                        <p className="text-xs text-muted-foreground mt-0.5">Initial baseline: {project.expectedTotalInitialDays} day(s)</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Financial Information — request-origin only, identical gating
                to the old "Project Request Setup" card's own cost grid.
                Expense Type now lives here (moved from General Information),
                positioned before Estimated/Actual Cost since it's the input
                those figures are derived from. projectEstimatedCost/
                projectActualCost are derived from this Project's own
                Activities (see computeProjectFinancials above) regardless of
                origin, but only ever rendered here, exactly as before. Up to
                4 fields now (Expense Type is conditional, the other 3 always
                render in this branch) — sm:grid-cols-2 lg:grid-cols-4 stays
                balanced whether Expense Type is present or not. */}
            {project.projectRequest && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Wallet className="h-3 w-3" /> Financial Information
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {project.expenseType && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Expense Type</p>
                      <p className="font-medium">
                        {project.expenseType.name}
                        {!project.expenseType.isActive && <span className="text-muted-foreground font-normal"> (inactive)</span>}
                      </p>
                    </div>
                  )}
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
              </div>
            )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <ProjectRelatedTicketsCard
            projectId={project.id}
            projectTitle={project.title}
            initialTickets={relatedTickets.map((t) => ({ id: t.id, ticketNumber: t.ticketNumber, title: t.title, status: { name: t.status.name, color: t.status.color } }))}
            departmentId={project.departmentId}
            canLinkTickets={canLinkTickets}
          />

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
                    NOT_STARTED: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
                    IN_PROGRESS: "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400",
                    ON_TRACK: "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400",
                    AT_RISK: "bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400",
                    COMPLETED: "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400",
                    CANCELLED: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400",
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

      {/* Project Feedback — the FULL evaluation form no longer lives on
          this page at all; it's a dedicated standalone route
          (/projects/[id]/feedback). This is only a small CTA, ONLY ever
          rendered for a request-origin Project (feedbackEligibility is
          null for a manual one), and even then only once the viewer is
          confirmed to be the Project's own primary Owner (Project.ownerId
          — never the full `owners` set, Audience, Members, the original
          requester, or ADMIN merely by role; see this feature's own
          eligibility rule in lib/services/project-feedback-service.ts).
          Before completion AND with no existing feedback (Case A),
          nothing is rendered — never an empty/disabled placeholder card. */}
      {feedbackEligibility?.isPrimaryOwner && (feedbackEligibility.isProjectCompleted || feedbackEligibility.feedback) && (
        <ProjectFeedbackCtaCard projectId={project.id} hasExistingFeedback={feedbackEligibility.feedback !== null} />
      )}

      {/* Activities — now its own full-width block (previously shared a
          2/3-width column with the Related Tickets rail) so its rows get
          the full page width to lay out titles/statuses/owners/dates
          without unnecessary truncation. Related Tickets moved up to pair
          with Project Overview instead (see the grid above). */}
      {activitySequenceRows ? (
        <ProjectActivitySequenceCard
          projectId={project.id}
          projectTitle={project.title}
          initialActivities={activitySequenceRows}
          initialProgress={project.progress}
          progressIsCalculated={progressIsCalculated}
          canReorder={canEditActivities}
          departmentId={project.departmentId}
          canLinkActivities={canEditActivities}
        />
      ) : (
        <ProjectActivitiesCard
          projectId={project.id}
          projectTitle={project.title}
          initialActivities={activityRows}
          initialProgress={project.progress}
          progressIsCalculated={progressIsCalculated}
          departmentId={project.departmentId}
          canLinkActivities={canEditActivities}
        />
      )}

      {/* Full-width below — chronological/list content that can grow
          arbitrarily tall (a long note thread, many attachments), which
          fits page width better than a narrower column. */}
      <div className="space-y-4">
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
    </div>
  );
}
