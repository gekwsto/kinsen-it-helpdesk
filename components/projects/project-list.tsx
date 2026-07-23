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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Users } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ProjectStatus } from "@prisma/client";
import type { ViewMode } from "@/components/ui/view-toggle";

const STATUS_COLORS: Record<ProjectStatus, string> = {
  PLANNING: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-amber-100 text-amber-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-700",
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "Low",
  2: "Medium",
  3: "High",
};

export interface ProjectListItem {
  id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  priority: number;
  startDate: Date | null;
  endDate: Date | null;
  department: { id: string; name: string } | null;
  members: { id: string; name: string | null; image: string | null }[];
  _count: { activities: number };
}

interface ProjectListProps {
  projects: ProjectListItem[];
}

/** Grid (cards) / List (table) — same data and scope either way, just a different render, toggled via ?view= (see components/ui/view-toggle.tsx). */
export function ProjectList({ projects }: ProjectListProps) {
  const searchParams = useSearchParams();
  const view = (searchParams.get("view") as ViewMode | null) ?? "grid";

  if (view === "list") {
    return (
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Name</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Date range</TableHead>
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
                  <Badge variant="outline" className="text-xs">
                    Priority {PRIORITY_LABELS[project.priority]}
                  </Badge>
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
                  <span className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5" />
                    {project.members.length}
                  </span>
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
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[project.status]}`}
                >
                  {project.status.replace("_", " ")}
                </span>
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
