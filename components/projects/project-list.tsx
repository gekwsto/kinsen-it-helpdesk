"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Calendar, Users, Eye, FolderKanban, FileText } from "lucide-react";
import { formatDate, getInitials } from "@/lib/utils";
import { ProjectStatus } from "@prisma/client";
import { resolveViewMode, type ViewMode } from "@/components/ui/view-toggle";
import { PROJECT_PRIORITY_LABEL as PRIORITY_LABELS, projectPriorityKey } from "@/lib/project-priority";
import { OverdueBadge } from "@/components/shared/overdue-badge";
import { MemberPreview } from "@/components/shared/member-preview";
import { PriorityBadge } from "@/components/shared/priority-badge";
import { PreviewField } from "@/components/shared/preview-field";

const STATUS_COLORS: Record<ProjectStatus, string> = {
  PLANNING: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-amber-100 text-amber-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

export interface ProjectListItem {
  id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  priority: number;
  startDate: Date | null;
  endDate: Date | null;
  /** Derived server-side via lib/overdue.ts — never a stored/stale flag. */
  overdue: boolean;
  department: { id: string; name: string } | null;
  members: { id: string; name: string | null; image: string | null }[];
  _count: { activities: number };
  /** The single canonical primary Owner — always a member of `owners` below. Preview-only field; the list's own rows never rendered it before. */
  owner: { id: string; name: string | null; image: string | null };
  /** The AUTHORITATIVE full Owner set (request-origin Projects only — mirrors `owner` alone for a manual Project). Preview-only. */
  owners: { id: string; name: string | null; image: string | null }[];
  /** Request-origin Projects only — always empty for a manual one. Preview-only. */
  audience: { id: string; name: string | null; image: string | null }[];
  /** Server-derived progress (0-100) — same field the Project detail page's own progress bar reads. Preview-only. */
  progress: number;
  /** Request-origin-only planning dates — distinct from the legacy startDate/endDate above. Preview-only. */
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  /** The originating Project Request, if this Project was created through that flow. Preview-only. */
  projectRequest: { id: string; title: string } | null;
  /** Canonical creation timestamp — Project.createdAt, never a derived/approximated date. */
  createdAt: Date;
}

interface ProjectListProps {
  projects: ProjectListItem[];
  /** Matches the ViewToggle's own `defaultView` on the SAME page (see components/ui/view-toggle.tsx's resolveViewMode) — these are two independent Client Components reading the same `?view=` param, not prop-linked, so both must agree. Defaults to "grid" (this component's historical behavior) for any other caller. */
  defaultView?: ViewMode;
}

/**
 * Grid (cards) / List (table) — same data and scope either way, just a
 * different render, toggled via ?view= (see components/ui/view-toggle.tsx).
 * List view's column headers are individually sortable — see
 * components/ui/sortable-table-head.tsx and the server page's
 * PROJECT_SORT_KEYS whitelist.
 *
 * Preview: mirrors the Project Requests list's own canonical pattern
 * (components/project-requests/project-request-table.tsx) exactly — a
 * local-state Dialog over a row already present in `projects` (no per-row
 * fetch, no N+1; the server page's own list query already carries every
 * field preview needs), opened via a dedicated Eye-icon trigger that never
 * changes how the rest of the row/card navigates.
 */
export function ProjectList({ projects, defaultView = "grid" }: ProjectListProps) {
  const searchParams = useSearchParams();
  const view = resolveViewMode(searchParams.get("view"), defaultView);
  const [previewTarget, setPreviewTarget] = useState<ProjectListItem | null>(null);

  const content =
    view === "list" ? (
      <div className="rounded-lg border overflow-hidden">
        <TooltipProvider delayDuration={200}>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <SortableTableHead sortKey="title">Name</SortableTableHead>
              <SortableTableHead sortKey="department">Department</SortableTableHead>
              <SortableTableHead sortKey="status">Status</SortableTableHead>
              <SortableTableHead sortKey="priority">Priority</SortableTableHead>
              <SortableTableHead sortKey="startDate">Date range</SortableTableHead>
              <TableHead>Owners</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Activities</TableHead>
              <SortableTableHead sortKey="createdAt">Created</SortableTableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link href={`/projects/${project.id}`} className="font-medium hover:text-primary line-clamp-1">
                    {project.title}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {project.department?.name ?? "—"}
                </TableCell>
                <TableCell>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[project.status]}`}>
                    {project.status.replace("_", " ")}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <PriorityBadge priority={projectPriorityKey(project.priority)} />
                    {project.overdue && <OverdueBadge />}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {project.startDate || project.endDate ? (
                    <span className="flex items-center gap-1.5">
                      <Calendar className="h-3.5 w-3.5" />
                      {project.startDate && formatDate(project.startDate)}
                      {project.startDate && project.endDate && " → "}
                      {project.endDate && formatDate(project.endDate)}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  {(() => {
                    // owners mirrors ownerId alone for a manual Project
                    // (see Project.owners' own schema doc comment) —
                    // falling back to the single canonical owner keeps
                    // this cell correct even for a legacy row where
                    // `owners` somehow came back empty.
                    const displayOwners = project.owners.length > 0 ? project.owners : [project.owner];
                    return (
                      <MemberPreview members={displayOwners} label="Owners">
                        <div className="flex items-center gap-1">
                          {displayOwners.slice(0, 3).map((o) => (
                            <Avatar key={o.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
                              <AvatarImage src={o.image ?? undefined} />
                              <AvatarFallback className="text-[9px]">{getInitials(o.name)}</AvatarFallback>
                            </Avatar>
                          ))}
                          {displayOwners.length > 3 && (
                            <span className="text-xs text-muted-foreground ml-1">+{displayOwners.length - 3}</span>
                          )}
                        </div>
                      </MemberPreview>
                    );
                  })()}
                </TableCell>
                <TableCell>
                  {project.members.length > 0 ? (
                    <MemberPreview members={project.members} label="Members">
                      <div className="flex items-center gap-1">
                        {project.members.slice(0, 3).map((m) => (
                          <Avatar key={m.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
                            <AvatarImage src={m.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">{getInitials(m.name)}</AvatarFallback>
                          </Avatar>
                        ))}
                        {project.members.length > 3 && (
                          <span className="text-xs text-muted-foreground ml-1">+{project.members.length - 3}</span>
                        )}
                      </div>
                    </MemberPreview>
                  ) : (
                    <span className="text-xs text-muted-foreground">No members</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{project._count.activities}</TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDate(project.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setPreviewTarget(project)} title="Preview this project">
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <Link href={`/projects/${project.id}`}>View</Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </TooltipProvider>
      </div>
    ) : (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <Link key={project.id} href={`/projects/${project.id}`}>
            <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base line-clamp-2">
                    {project.title}
                  </CardTitle>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {project.overdue && <OverdueBadge />}
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[project.status]}`}
                    >
                      {project.status.replace("_", " ")}
                    </span>
                    {/* Preview trigger — stops the click reaching the
                        enclosing <Link>, same convention already used by
                        ActivityCompleteCheckbox nested inside a row Link. */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      title="Preview this project"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setPreviewTarget(project);
                      }}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {project.description && (
                  <CardDescription className="line-clamp-2">
                    {project.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {project.department && (
                    <span>{project.department.name}</span>
                  )}
                  <Badge variant="outline" className="text-xs">
                    Priority {PRIORITY_LABELS[project.priority]}
                  </Badge>
                </div>

                {(project.startDate || project.endDate) && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" />
                    {project.startDate && formatDate(project.startDate)}
                    {project.startDate && project.endDate && " → "}
                    {project.endDate && formatDate(project.endDate)}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    {project.members.length} member{project.members.length !== 1 ? "s" : ""}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {project._count.activities} activities
                  </span>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    );

  return (
    <>
      {content}

      {/* Preview dialog — read-only Project detail, loaded from the SAME
          row data the list already fetched (no per-row/N+1 request) —
          mirrors components/project-requests/project-request-table.tsx's
          own Preview dialog exactly: same container size, same info-grid
          header, same scrollable PreviewField body, same Close + "Open"
          footer pattern. No edit controls anywhere. */}
      <Dialog open={!!previewTarget} onOpenChange={(o) => !o && setPreviewTarget(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="pr-6 break-words">{previewTarget?.title}</DialogTitle>
          </DialogHeader>
          {previewTarget && (
            <div className="flex-1 min-h-0 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm border rounded-md p-3 bg-muted/30 flex-shrink-0">
                <div>
                  <span className="text-muted-foreground">Status: </span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[previewTarget.status]}`}>
                    {previewTarget.status.replace("_", " ")}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Workspace: </span>
                  <span className="font-medium">{previewTarget.department?.name ?? "—"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Progress: </span>
                  <span className="font-medium">{previewTarget.progress}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Priority: </span>
                  <span className="font-medium">{PRIORITY_LABELS[previewTarget.priority]}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Owner(s): </span>
                  <span className="font-medium">
                    {(previewTarget.owners.length > 0 ? previewTarget.owners : [previewTarget.owner]).map((o) => o.name ?? "—").join(", ")}
                  </span>
                </div>
                <div>
                  <span className="text-muted-foreground">Activities: </span>
                  <span className="font-medium">{previewTarget._count.activities}</span>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-md border divide-y">
                {(previewTarget.expectedStartDate || previewTarget.expectedFinishDate) ? (
                  <PreviewField
                    label="Expected Timeline"
                    value={[
                      previewTarget.expectedStartDate ? `Start: ${formatDate(previewTarget.expectedStartDate)}` : null,
                      previewTarget.expectedFinishDate ? `Finish: ${formatDate(previewTarget.expectedFinishDate)}` : null,
                    ]
                      .filter(Boolean)
                      .join("  ·  ")}
                  />
                ) : (
                  (previewTarget.startDate || previewTarget.endDate) && (
                    <PreviewField
                      label="Date range"
                      value={[
                        previewTarget.startDate ? formatDate(previewTarget.startDate) : null,
                        previewTarget.endDate ? formatDate(previewTarget.endDate) : null,
                      ]
                        .filter(Boolean)
                        .join(" → ")}
                    />
                  )
                )}
                {previewTarget.description && <PreviewField label="Description" value={previewTarget.description} multiline />}
                <PreviewField
                  label="Members"
                  value={previewTarget.members.length > 0 ? previewTarget.members.map((m) => m.name ?? "Unnamed").join(", ") : "No members"}
                />
                {previewTarget.audience.length > 0 && (
                  <PreviewField label="Audience" value={previewTarget.audience.map((a) => a.name ?? "Unnamed").join(", ")} />
                )}
                {previewTarget.projectRequest && (
                  <div className="px-4 py-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">Project Request</p>
                    <Link href={`/project-requests/${previewTarget.projectRequest.id}`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
                      <FileText className="h-3.5 w-3.5" />
                      {previewTarget.projectRequest.title}
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTarget(null)}>
              Close
            </Button>
            {previewTarget && (
              <Button asChild>
                <Link href={`/projects/${previewTarget.id}`}>
                  <FolderKanban className="h-3.5 w-3.5 mr-1.5" />
                  Open Project
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
