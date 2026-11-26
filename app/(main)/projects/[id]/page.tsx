import { auth } from "@/lib/auth";
import { SkippedIntermediateStage, SkippedFinalStage } from "@/components/project-requests/skipped-stage";
import { prisma } from "@/lib/prisma";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { canViewProjectRequest } from "@/lib/services/project-request-service";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDateOnly, formatDateTime, getInitials } from "@/lib/utils";
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
import { getFacilitiesServicesDepartmentId, formatFacilitiesQuarterLabel } from "@/lib/services/project-facilities-service";
import { getFacilitiesImportanceGroupCounts, computeFacilitiesScorePercent } from "@/lib/services/project-scoring-service";
import { getImportanceScoreFraction, formatScorePercent } from "@/lib/project-scoring-shared";
import { FolderKanban, Wallet, Building2, ClipboardCheck, Briefcase } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserAvatarTooltip } from "@/components/shared/user-avatar-tooltip";

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
      // Organizational Audience (Phase 1) — unlike `audience` above,
      // available on EVERY Project (not request-origin-only); see
      // Project.audienceDepartments/audienceBusinessUnits's own schema
      // doc comment. Membership is resolved dynamically elsewhere
      // (hasProjectViewAccess) — these are only the entities THEMSELVES,
      // never expanded into their member users here.
      audienceDepartments: { select: { id: true, name: true } },
      audienceBusinessUnits: { select: { id: true, name: true } },
      // Responsible People (Phase 2) — a PERMANENT, independent
      // relationship (never Audience/Owner(s)/Members storage), available
      // on EVERY Project regardless of Department or status; see
      // Project.responsiblePeople's own schema doc comment.
      responsiblePeople: { select: { id: true, name: true, email: true, image: true } },
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
      // Request & Approvals section below — one extra query depth, not an
      // extra round trip (same `include`, loaded alongside everything
      // else this page already needs). requesterId/departmentId are
      // selected ONLY for the canViewProjectRequest authorization check
      // below, never rendered directly.
      projectRequest: {
        select: {
          id: true,
          title: true,
          requesterId: true,
          departmentId: true,
          submittedAt: true,
          source: true,
          status: true,
          intermediateApprovalSkipReason: true,
          finalApprovalSkipped: true,
          finalApprovalSkippedAt: true,
          finalApprovalSkippedBy: { select: { name: true, email: true } },
          requester: { select: { id: true, name: true, email: true, image: true } },
          // Snapshot of the requester's OWN department at submission —
          // never the request's target department (`project.department`
          // above, unrelated). Read from the relation, never re-derived
          // from the requester's current membership.
          requesterDepartment: { select: { id: true, name: true } },
          intermediateApprovers: {
            select: {
              id: true,
              status: true,
              decidedAt: true,
              businessAssessment: true,
              approver: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: { createdAt: "asc" },
          },
          approver: { select: { id: true, name: true, email: true, image: true } },
          approvedAt: true,
          rejectedAt: true,
          businessAssessment: true,
        },
      },
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

  // Request & Approvals section — gated by the SAME, narrower
  // authorization rule the Project Request detail page itself uses
  // (canViewProjectRequest: the original requester, a user with effective
  // projectRequest.approve for the request's own department, or one of
  // the request's own selected intermediate approvers). Deliberately NOT
  // the broader canView above — a Project Member/Owner/Audience user can
  // see this Project without being entitled to see who was asked to
  // approve it or their individual written justifications, which is
  // exactly the exposure this separate check exists to prevent. A Project
  // with no originating request at all trivially never shows the section
  // either way.
  const canViewRequestApprovals = project.projectRequest
    ? await canViewProjectRequest(session.user.id, session.user.role, session.user.customRoleId, project.projectRequest)
    : false;

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

  // Facilities Services-only — id comparison only, never a display-name
  // match. Governs the "Facilities Information" section AND whether
  // "Actual Timeline" shows "Q2 2027" instead of a formatted exact date.
  // Deliberately NOT gated on "any facilities field being non-null" —
  // once a Project leaves this workspace, its historical Facilities
  // metadata stays in the DB (never cleared, see PATCH /api/projects/[id]'s
  // own doc comment) but is no longer shown here, satisfying "hide it
  // outside the workspace."
  const facilitiesServicesDepartmentId = await getFacilitiesServicesDepartmentId();
  const isFacilitiesServicesWorkspace = !!facilitiesServicesDepartmentId && project.departmentId === facilitiesServicesDepartmentId;
  const facilitiesStartLabel = isFacilitiesServicesWorkspace ? formatFacilitiesQuarterLabel(project.facilitiesStartQuarter, project.facilitiesStartYear) : null;
  const facilitiesEndLabel = isFacilitiesServicesWorkspace ? formatFacilitiesQuarterLabel(project.facilitiesEndQuarter, project.facilitiesEndYear) : null;
  // Facilities Costs — directly entered, NEVER summed/overwritten/conflated
  // with the Activity-derived rollup below (projectEstimatedCost/
  // projectActualCost). Same "hidden outside the workspace, preserved in
  // the DB" rule as the rest of this Project's Facilities metadata.
  const hasFacilitiesCostData =
    isFacilitiesServicesWorkspace &&
    (project.facilitiesEstimatedCost !== null ||
      project.facilitiesActualCost !== null ||
      !!project.facilitiesEstimatedCostNotes ||
      !!project.facilitiesActualCostNotes);

  // Project Scoring — computed fresh on every load, never stored (see
  // lib/services/project-scoring-service.ts). The grouped count is fetched
  // ONCE here, not per-project; this page only ever renders one Project.
  const facilitiesImportanceScoreFraction = isFacilitiesServicesWorkspace
    ? getImportanceScoreFraction(project.facilitiesProjectImportanceOverall)
    : null;
  const facilitiesScorePercent = isFacilitiesServicesWorkspace
    ? computeFacilitiesScorePercent(project.facilitiesProjectImportanceOverall, project.facilitiesProjectScore, await getFacilitiesImportanceGroupCounts())
    : null;

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

            {/* Request & Approvals — gated on canViewRequestApprovals, a
                NARROWER check than this whole page's own canView (see its
                computation above): a Project Member/Owner/Audience user who
                can see this Project at all does not automatically see who
                was asked to approve its originating request or their
                individual written justifications. Displays ONLY the actual
                persisted history (ProjectRequest/ProjectRequestIntermediate
                Approver rows) — never inferred/reconstructed. Omitted
                entirely for a manually-created Project (project.projectRequest
                is null), matching "Manually created Projects must remain
                unchanged." */}
            {canViewRequestApprovals && project.projectRequest && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <ClipboardCheck className="h-3 w-3" /> Request &amp; Approvals
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {/* Source — always shown (Standard vs. Historical
                      Import), same reasoning as the standalone Project
                      Request detail page's own Source field. */}
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Source</p>
                    <p className="font-medium">{project.projectRequest.source === "HISTORICAL_IMPORT" ? "Historical Import" : "Standard"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Requested By</p>
                    <p className="font-medium">
                      {project.projectRequest.requester ? project.projectRequest.requester.name ?? project.projectRequest.requester.email : "Not recorded"}
                    </p>
                  </div>
                  {/* Snapshot of the requester's OWN department at
                      submission — distinct from this Project's own
                      department above, and never re-derived from the
                      requester's CURRENT membership. "Not recorded" for a
                      request that predates this field, whose requester had
                      no primary department at submission time, or a
                      Historical Import request whose source data didn't
                      record one. */}
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Requester Department</p>
                    <p className="font-medium">{project.projectRequest.requesterDepartment?.name ?? "Not recorded"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Submitted</p>
                    <p className="font-medium">{project.projectRequest.submittedAt ? formatDateTime(project.projectRequest.submittedAt) : "Not recorded"}</p>
                  </div>
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground mb-1">Original Project Request</p>
                    <Link href={`/project-requests/${project.projectRequest.id}`} className="inline-flex items-center gap-1.5 font-medium text-primary hover:underline">
                      <FolderKanban className="h-3.5 w-3.5" />
                      {project.projectRequest.title}
                    </Link>
                  </div>
                </div>

                {/* Intermediate approvers — EVERY selected approver shown
                    individually with their OWN decision/timestamp/comment
                    (never collapsed into a single "approved" summary),
                    preserving the unanimous-multi-approver distinction from
                    the final stage below. Empty for a request that skipped
                    this stage entirely (intermediateApprovalSkipReason) —
                    nothing to show, not an error. */}
                {project.projectRequest.intermediateApprovalSkipReason && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Intermediate Approval</p>
                    <SkippedIntermediateStage reason={project.projectRequest.intermediateApprovalSkipReason} className="text-xs rounded-md border px-3 py-2" />
                  </div>
                )}
                {project.projectRequest.finalApprovalSkipped && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Final Approval</p>
                    <SkippedFinalStage skippedBy={project.projectRequest.finalApprovalSkippedBy} skippedAt={project.projectRequest.finalApprovalSkippedAt} className="text-xs rounded-md border px-3 py-2" />
                  </div>
                )}
                {project.projectRequest.intermediateApprovers.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Intermediate Approval</p>
                    <div className="divide-y rounded-md border">
                      {project.projectRequest.intermediateApprovers.map((row) => (
                        <div key={row.id} className="px-3 py-2 text-xs space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 font-medium">
                              <Avatar className="h-5 w-5">
                                <AvatarImage src={row.approver.image ?? undefined} />
                                <AvatarFallback className="text-[9px]">{getInitials(row.approver.name)}</AvatarFallback>
                              </Avatar>
                              {row.approver.name ?? row.approver.email}
                              <span className="text-muted-foreground font-normal">· Intermediate Approver</span>
                            </span>
                            <span
                              className={
                                row.status === "APPROVED"
                                  ? "font-medium text-green-700"
                                  : row.status === "REJECTED"
                                  ? "font-medium text-red-700"
                                  : "font-medium text-muted-foreground"
                              }
                            >
                              {row.status === "APPROVED" ? "Approved" : row.status === "REJECTED" ? "Rejected" : "Pending"}
                              {row.decidedAt && <span className="text-muted-foreground font-normal"> · {formatDateTime(row.decidedAt)}</span>}
                            </span>
                          </div>
                          {row.businessAssessment && <p className="text-muted-foreground whitespace-pre-wrap">{row.businessAssessment}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Final approval — distinct from the intermediate stage
                    above (separate fields, separate audit trail — see
                    ProjectRequest's own schema doc comment). A Project
                    only exists once its request's FINAL approval
                    completed (status APPROVED) OR it was brought in via
                    Historical Import (status IMPORTED, its OWN distinct
                    terminal status — see ProjectRequestStatus's own
                    schema doc comment, Phase 3.1). The label itself is
                    derived from `status`, never inferred from
                    approvedAt/rejectedAt presence alone — an IMPORTED
                    request may have a real, preserved approvedAt from
                    source data without ever having gone through the
                    standard workflow, and must never display as literal
                    "Approved" in that case. A Historical Import request
                    whose source data didn't record WHO approved it
                    (approver null) shows an explicit "Not recorded" —
                    never silently omitted (which would look like approval
                    never happened at all) and never fabricated. */}
                {project.projectRequest.status === "IMPORTED" ? (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">Final Approval</p>
                    {project.projectRequest.approver ? (
                      <div className="rounded-md border px-3 py-2 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            <Avatar className="h-5 w-5">
                              <AvatarImage src={project.projectRequest.approver.image ?? undefined} />
                              <AvatarFallback className="text-[9px]">{getInitials(project.projectRequest.approver.name)}</AvatarFallback>
                            </Avatar>
                            {project.projectRequest.approver.name ?? project.projectRequest.approver.email}
                            <span className="text-muted-foreground font-normal">· Final Approver</span>
                          </span>
                          <span className="font-medium text-muted-foreground">
                            Imported
                            {project.projectRequest.approvedAt && (
                              <span className="font-normal"> · {formatDateTime(project.projectRequest.approvedAt)}</span>
                            )}
                          </span>
                        </div>
                        {project.projectRequest.businessAssessment && (
                          <p className="text-muted-foreground whitespace-pre-wrap">{project.projectRequest.businessAssessment}</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground rounded-md border px-3 py-2">Not recorded (historical import)</p>
                    )}
                  </div>
                ) : (
                  project.projectRequest.approver && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">Final Approval</p>
                      <div className="rounded-md border px-3 py-2 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 font-medium">
                            <Avatar className="h-5 w-5">
                              <AvatarImage src={project.projectRequest.approver.image ?? undefined} />
                              <AvatarFallback className="text-[9px]">{getInitials(project.projectRequest.approver.name)}</AvatarFallback>
                            </Avatar>
                            {project.projectRequest.approver.name ?? project.projectRequest.approver.email}
                            <span className="text-muted-foreground font-normal">· Final Approver</span>
                          </span>
                          <span className={project.projectRequest.approvedAt ? "font-medium text-green-700" : "font-medium text-red-700"}>
                            {project.projectRequest.approvedAt ? "Approved" : "Rejected"}
                            {(project.projectRequest.approvedAt ?? project.projectRequest.rejectedAt) && (
                              <span className="text-muted-foreground font-normal">
                                {" "}
                                · {formatDateTime(project.projectRequest.approvedAt ?? project.projectRequest.rejectedAt!)}
                              </span>
                            )}
                          </span>
                        </div>
                        {project.projectRequest.businessAssessment && (
                          <p className="text-muted-foreground whitespace-pre-wrap">{project.projectRequest.businessAssessment}</p>
                        )}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}

            {/* Facilities Information — Facilities Services-only, placed
                immediately after General Information. Company/Location/
                Category are all optional, so each is only ever rendered
                when actually set (never an empty "—" placeholder cell).
                Planned for Annual Targets/Big Project are plain, always-set
                Booleans (never null) — shown unconditionally as Yes/No
                whenever this Project is IN the workspace, per this
                feature's own "show clearly as Yes/No, never hide an
                unchecked value" requirement; this is also why the section
                itself now renders whenever isFacilitiesServicesWorkspace is
                true, even with no Company/Location/Category set — there's
                always at least these two rows to show. */}
            {isFacilitiesServicesWorkspace && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Building2 className="h-3 w-3" /> Facilities Information
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {project.facilitiesCompany && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Company</p>
                      <p className="font-medium">{project.facilitiesCompany}</p>
                    </div>
                  )}
                  {project.facilitiesLocation && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Location</p>
                      <p className="font-medium">{project.facilitiesLocation}</p>
                    </div>
                  )}
                  {project.facilitiesCategory && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Category</p>
                      <p className="font-medium">{project.facilitiesCategory}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Planned for This Year&apos;s Targets</p>
                    <p className="font-medium">{project.facilitiesPlannedForAnnualTargets ? "Yes" : "No"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Big Project</p>
                    <p className="font-medium">{project.facilitiesIsBigProject ? "Yes" : "No"}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Project Scoring — Facilities Services-only, compact, all
                four fields always shown (never hidden for an unset value —
                "Not set" instead, same convention as Score below). Score/
                Importance Score are derived fresh on every page load, never
                a stored value — see lib/services/project-scoring-service.ts. */}
            {isFacilitiesServicesWorkspace && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Target className="h-3 w-3" /> Project Scoring
                </p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Project Importance Overall</p>
                    <p className="font-medium">{project.facilitiesProjectImportanceOverall ?? "Not set"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Project Importance Score</p>
                    <p className="font-medium">{formatScorePercent(facilitiesImportanceScoreFraction)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Project Score</p>
                    <p className="font-medium">{project.facilitiesProjectScore ?? "Not set"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Score</p>
                    <p className="font-medium">{formatScorePercent(facilitiesScorePercent)}</p>
                  </div>
                </div>
              </div>
            )}

            {/* People — always at least an Owner (every Project has one; see
                ownersToShow's own doc comment above), Members/Audience only
                when non-empty. Wrapped in TooltipProvider for Responsible
                People's own name+role hover preview (UserAvatarTooltip) —
                same established convention as project-activities-card.tsx. */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">People</p>
              <TooltipProvider delayDuration={200}>
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

                {/* Audience — available on every Project as of Phase 1.1
                    (previously request-origin only), zero or more; distinct
                    from both Owner(s) and Members. Only rendered when
                    non-empty, same "no empty placeholder" convention as
                    Members. */}
                {project.audience.length > 0 && (
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

                {/* Responsible People (Phase 2) — a PERMANENT, independent
                    relationship, distinct from Owner(s)/Members/Audience
                    above (never written into any of those relations).
                    Available on every Project regardless of Department or
                    status. Uses UserAvatarTooltip (name + role on hover)
                    per this feature's own UI requirement — unlike the
                    plain avatar+name chips above, which this task leaves
                    untouched. */}
                {project.responsiblePeople.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Users className="h-3 w-3" /> Responsible People
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.responsiblePeople.map((r) => (
                        <UserAvatarTooltip key={r.id} user={r} roles={["Responsible"]} avatarClassName="h-5 w-5" fallbackClassName="text-[9px]" />
                      ))}
                    </div>
                  </div>
                )}

                {/* Organizational Audience (Phase 1) — available on EVERY
                    Project (unlike the request-origin-only Audience block
                    above), since Department/Business Unit audience
                    membership is resolved dynamically rather than
                    expanded into a static list; see
                    hasProjectViewAccess's own doc comment. Rendered as
                    entity names, never their member users. */}
                {project.audienceDepartments.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Building2 className="h-3 w-3" /> Audience — Departments
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.audienceDepartments.map((d) => (
                        <Badge key={d.id} variant="secondary" className="text-xs font-normal">
                          {d.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {project.audienceBusinessUnits.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Briefcase className="h-3 w-3" /> Audience — Business Units
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {project.audienceBusinessUnits.map((b) => (
                        <Badge key={b.id} variant="secondary" className="text-xs font-normal">
                          {b.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              </TooltipProvider>
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
                      {/* Facilities Services with Quarter precision: show
                          "Q2 2027" — the explicit precision metadata — never
                          the derived boundary date formatted as if it were a
                          real user-entered exact date (see this Project's
                          own isFacilitiesServicesWorkspace/
                          facilitiesStartLabel computation above). */}
                      {project.startDate && <p>Start: {facilitiesStartLabel ?? formatDateOnly(project.startDate)}</p>}
                      {project.endDate && <p>End: {facilitiesEndLabel ?? formatDateOnly(project.endDate)}</p>}
                      {project.actualTotalDays !== null && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Actual total: {project.actualTotalDays} working day(s){project.actualTotalDaysOverridden ? " (manually set)" : ""}
                        </p>
                      )}
                    </div>
                  )}
                  {project.projectRequest && (project.expectedStartDate || project.expectedFinishDate) && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Expected Timeline</p>
                      {project.expectedStartDate && <p>Start: {formatDateOnly(project.expectedStartDate)}</p>}
                      {project.expectedFinishDate && <p>Finish: {formatDateOnly(project.expectedFinishDate)}</p>}
                      {project.expectedTotalInitialDays !== null && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Expected total initial: {project.expectedTotalInitialDays} working day(s){project.expectedTotalInitialDaysOverridden ? " (manually set)" : ""}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Financial Information — TWO DISTINCT, never-conflated sources:
                Facilities Costs (direct manual entry, Facilities Services
                workspace only) and Activity Costs (the pre-existing
                request-origin-only computeProjectFinancials rollup, totally
                unmodified). A standalone Facilities Project shows only the
                first sub-section; a request-origin Facilities Project shows
                both; every other Project's behavior is byte-for-byte
                unchanged from before this feature existed. */}
            {(project.projectRequest || hasFacilitiesCostData) && (
              <div className="space-y-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Wallet className="h-3 w-3" /> Financial Information
                </p>

                {hasFacilitiesCostData && (
                  <div className="space-y-3">
                    {project.projectRequest && <p className="text-xs font-medium text-muted-foreground">Facilities Costs (Manual Entry)</p>}
                    {(project.facilitiesEstimatedCost !== null || project.facilitiesActualCost !== null) && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {project.facilitiesEstimatedCost !== null && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Estimated Cost</p>
                            <p className="font-medium">{formatEUR(Number(project.facilitiesEstimatedCost))}</p>
                          </div>
                        )}
                        {project.facilitiesActualCost !== null && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Actual Cost</p>
                            <p className="font-medium">{formatEUR(Number(project.facilitiesActualCost))}</p>
                          </div>
                        )}
                      </div>
                    )}
                    {(project.facilitiesEstimatedCostNotes || project.facilitiesActualCostNotes) && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {project.facilitiesEstimatedCostNotes && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Estimated Cost Notes</p>
                            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{project.facilitiesEstimatedCostNotes}</p>
                          </div>
                        )}
                        {project.facilitiesActualCostNotes && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">Actual Cost Notes</p>
                            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{project.facilitiesActualCostNotes}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {project.projectRequest && (
                  <div className="space-y-2">
                    {hasFacilitiesCostData && <p className="text-xs font-medium text-muted-foreground">Activity Costs (Calculated)</p>}
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
          confirmed to be a Feedback recipient (a persisted obligation on
          tracked Projects; the live Responsible People / primary Owner
          rule on historical untracked ones — never the full `owners` set
          as such, Audience, Members, or ADMIN merely by role; see
          isFeedbackRecipient in lib/services/project-feedback-service.ts). The prompt reflects the
          viewer's OWN Feedback (submitted or not).
          Before completion AND with no existing feedback (Case A),
          nothing is rendered — never an empty/disabled placeholder card. */}
      {feedbackEligibility?.isRecipient && (feedbackEligibility.isProjectCompleted || feedbackEligibility.feedback) && (
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
