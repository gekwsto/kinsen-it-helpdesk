"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Pencil, Plus } from "lucide-react";
import { ProjectStatusBadge, type ProjectStatusDisplay } from "@/components/projects/project-status-badge";
import { ProjectDeleteButton } from "@/components/projects/project-delete-button";
import { ExportProjectButton } from "@/components/projects/export-project-button";
import { ProjectQuickStatus } from "@/components/projects/project-quick-status";

// Status pill + dropdown show the CONFIGURED Project Status (global
// ProjectStatusDefinition — label/color/order set in Administration ->
// Project Statuses); the canonical lifecycle state never drives display.

interface ProjectDetailHeaderProps {
  projectId: string;
  title: string;
  description: string | null;
  /** The Project's configured status (display) — see lib/services/project-status-service.ts. */
  initialStatus: ProjectStatusDisplay;
  /** Every configured Project Status (display order); the dropdown offers the ACTIVE ones plus the current one. */
  statusDefinitions: ProjectStatusDisplay[];
  isGoal: boolean;
  /** Whether the current user holds project.edit in this Project's department. */
  canEditProject: boolean;
  /** Whether the current user holds project.delete in this Project's department — a SEPARATE, independently-grantable permission from project.edit (see prisma/seed.ts). */
  canDeleteProject: boolean;
}

/**
 * The only client-rendered slice of the otherwise server-rendered Project
 * detail page (app/(main)/projects/[id]/page.tsx) — just the title row's
 * status pill plus the action button bar, which must share one `status`
 * state so the pill and the quick-status dropdown can never disagree (see
 * the "one source of truth" requirement) — both update INSTANTLY from the
 * mutation's own response, never waiting on a refresh. The rest of the
 * page (activities list, related tickets, notes, sidebar) stays server-
 * rendered — most of it has nothing to do with Project.status, but the
 * Project Feedback card's own eligibility DOES depend on it
 * (Project.status === COMPLETED; see getProjectFeedbackEligibility in
 * app/(main)/projects/[id]/page.tsx), so ProjectQuickStatus's own
 * handleSelect calls router.refresh() after a successful change — that
 * server-rendered content would otherwise stay stale (e.g. a still-visible
 * Feedback form after the Project just moved away from COMPLETED) until a
 * manual reload. The /projects list page is a different matter — PATCH /api/projects/[id]
 * publishes a project-list-changed realtime signal after a committed status
 * change (see lib/realtime/project-list-invalidation.ts) so an already-open
 * Projects list picks it up on its own, with no action needed here.
 */
export function ProjectDetailHeader({
  projectId,
  title,
  description,
  initialStatus,
  statusDefinitions,
  isGoal,
  canEditProject,
  canDeleteProject,
}: ProjectDetailHeaderProps) {
  const [status, setStatus] = useState<ProjectStatusDisplay>(initialStatus);
  const statusOptions = statusDefinitions
    .filter((d) => d.isActive !== false || d.id === status.id)
    .map((d) => ({ id: d.id, label: d.isActive === false ? `${d.label} (inactive)` : d.label, color: d.color }));

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{title}</h1>
          <ProjectStatusBadge status={status} className="px-2.5 py-1" />
          {isGoal && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
              Goal
            </span>
          )}
        </div>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ExportProjectButton projectId={projectId} />
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}/edit`}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Link>
        </Button>
        <ProjectQuickStatus
          projectId={projectId}
          currentStatus={status.id}
          currentStatusLabel={status.label}
          currentStatusColor={status.color}
          statuses={statusOptions}
          canEdit={canEditProject}
          onChanged={(newStatus) => setStatus(newStatus)}
        />
        <Button asChild>
          {/* Straight to the CREATE page with the Project pre-selected —
              previously linked to /activities?projectId=... (the filtered
              LIST page), whose own "New Activity" link then dropped
              projectId entirely, losing the Project context twice over
              before the user ever reached a create form. */}
          <Link href={`/activities/new?projectId=${projectId}`}>
            <Plus className="h-4 w-4 mr-2" />
            Add Activity
          </Link>
        </Button>
        {canDeleteProject && <ProjectDeleteButton projectId={projectId} projectTitle={title} />}
      </div>
    </div>
  );
}
