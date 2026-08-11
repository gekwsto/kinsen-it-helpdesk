"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Pencil, Plus } from "lucide-react";
import { ProjectStatus } from "@prisma/client";
import { ProjectDeleteButton } from "@/components/projects/project-delete-button";
import { ProjectQuickStatus } from "@/components/projects/project-quick-status";
import type { QuickStatusOption } from "@/components/status/quick-status-select";

// Same fixed mapping the Project detail page has always used for its status
// pill — there is no per-department color for ProjectStatus (unlike
// ActivityStatus, which has a real ActivityStatusConfig.color column; see
// prisma/schema.prisma's ProjectStatusConfig, which only stores
// `isTerminal`, no label/color/isEnabled). Reused here verbatim, not
// duplicated with different values, and documented in the final report as
// a pre-existing architecture gap rather than something newly invented.
const STATUS_BADGE_COLORS: Record<ProjectStatus, string> = {
  PLANNING: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-amber-100 text-amber-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

// Every ProjectStatus enum value, in declaration order — the SAME
// canonical source project-form.tsx's own status Select already uses
// (`Object.values(ProjectStatus)`), never a hand-typed list. Projects have
// no per-department enable/disable config to filter by (see the doc
// comment above), so every value is always offered.
const ALL_PROJECT_STATUSES: QuickStatusOption[] = Object.values(ProjectStatus).map((status) => ({
  id: status,
  label: humanizeStatus(status),
}));

interface ProjectDetailHeaderProps {
  projectId: string;
  title: string;
  description: string | null;
  initialStatus: ProjectStatus;
  isGoal: boolean;
  /** Whether the current user holds project.edit in this Project's department. */
  canEditProject: boolean;
  isAdmin: boolean;
}

/**
 * The only client-rendered slice of the otherwise server-rendered Project
 * detail page (app/(main)/projects/[id]/page.tsx) — just the title row's
 * status pill plus the action button bar, which must share one `status`
 * state so the pill and the quick-status dropdown can never disagree (see
 * the "one source of truth" requirement). Everything else on the page
 * (activities list, related tickets, notes, sidebar) stays server-rendered
 * and untouched; Project.status has no effect on any of that derived data,
 * so no router.refresh() is needed for this specific change.
 */
export function ProjectDetailHeader({
  projectId,
  title,
  description,
  initialStatus,
  isGoal,
  canEditProject,
  isAdmin,
}: ProjectDetailHeaderProps) {
  const [status, setStatus] = useState<ProjectStatus>(initialStatus);

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{title}</h1>
          <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_BADGE_COLORS[status]}`}>
            {humanizeStatus(status)}
          </span>
          {isGoal && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">
              Goal
            </span>
          )}
        </div>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline">
          <Link href={`/projects/${projectId}/edit`}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Link>
        </Button>
        <ProjectQuickStatus
          projectId={projectId}
          currentStatus={status}
          currentStatusLabel={humanizeStatus(status)}
          statuses={ALL_PROJECT_STATUSES}
          canEdit={canEditProject}
          onChanged={(newStatus) => setStatus(newStatus as ProjectStatus)}
        />
        <Button asChild>
          <Link href={`/activities?projectId=${projectId}`}>
            <Plus className="h-4 w-4 mr-2" />
            Add Activity
          </Link>
        </Button>
        {isAdmin && <ProjectDeleteButton projectId={projectId} projectTitle={title} />}
      </div>
    </div>
  );
}
