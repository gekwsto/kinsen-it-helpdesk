"use client";

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
import { TooltipProvider } from "@/components/ui/tooltip";
import { Calendar, Users } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ProjectStatus } from "@prisma/client";
import { resolveViewMode, type ViewMode } from "@/components/ui/view-toggle";
import { PROJECT_PRIORITY_LABEL as PRIORITY_LABELS } from "@/lib/project-priority";
import { OverdueBadge } from "@/components/shared/overdue-badge";
import { MemberPreview } from "@/components/shared/member-preview";

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
}

interface ProjectListProps {
  projects: ProjectListItem[];
  /** Matches the ViewToggle's own `defaultView` on the SAME page (see components/ui/view-toggle.tsx's resolveViewMode) — these are two independent Client Components reading the same `?view=` param, not prop-linked, so both must agree. Defaults to "grid" (this component's historical behavior) for any other caller. */
  defaultView?: ViewMode;
}

/** Grid (cards) / List (table) — same data and scope either way, just a different render, toggled via ?view= (see components/ui/view-toggle.tsx). List view's column headers are individually sortable — see components/ui/sortable-table-head.tsx and the server page's PROJECT_SORT_KEYS whitelist. */
export function ProjectList({ projects, defaultView = "grid" }: ProjectListProps) {
  const searchParams = useSearchParams();
  const view = resolveViewMode(searchParams.get("view"), defaultView);

  if (view === "list") {
    return (
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
              <TableHead>Members</TableHead>
              <TableHead>Activities</TableHead>
              <TableHead className="w-16"></TableHead>
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
                    <Badge variant="outline" className="text-xs">
                      Priority {PRIORITY_LABELS[project.priority]}
                    </Badge>
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
                <TableCell className="text-sm text-muted-foreground">
                  <MemberPreview members={project.members} label="Members">
                    <span className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      {project.members.length}
                    </span>
                  </MemberPreview>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{project._count.activities}</TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/projects/${project.id}`}>View</Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        </TooltipProvider>
      </div>
    );
  }

  return (
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
}
