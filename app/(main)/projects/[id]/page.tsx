import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ChevronRight, Calendar, Users, Target, Ticket } from "lucide-react";
import { GoalStatus } from "@prisma/client";
import { formatTicketNumber } from "@/lib/utils";
import { ProjectActivitiesCard } from "@/components/projects/project-activities-card";
import { getActivityStatusDisplayConfigsForDepartments, resolveActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { EntityNotes } from "@/components/notes/entity-notes";
import { EntityAttachments } from "@/components/attachments/entity-attachments";
import { EntityRelatedLinks } from "@/components/related-links/entity-related-links";
import { getRelatedLinksAccess, listRelatedLinksForPage } from "@/lib/services/related-links-service";
import { ProjectDetailHeader } from "@/components/projects/project-detail-header";

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
      department: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      members: { select: { id: true, name: true, email: true, image: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          assignedUsers: { select: { id: true, name: true, image: true } },
        },
      },
      yearlyGoals: { select: { id: true, year: true, status: true, targetValue: true, currentValue: true, unit: true } },
    },
  });

  if (!project) notFound();

  // Department-scoped, not just "can this role ever view projects" — this
  // page previously had no per-project check at all beyond that global gate.
  // hasEffectiveEntityPermission (global grant OR this entity's own department
  // grant) — bare canActOnEntity ignored a global role/custom-role project.view.
  // Department is the real row's, never the workspace or the client.
  const canView = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.view");
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

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Activities */}
        <div className="lg:col-span-2 space-y-4">
          <ProjectActivitiesCard
            projectId={project.id}
            initialActivities={activityRows}
            initialProgress={project.progress}
            progressIsCalculated={progressIsCalculated}
          />

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
