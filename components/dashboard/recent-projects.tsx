import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { OverdueBadge } from "@/components/shared/overdue-badge";

export interface DashboardProject {
  id: string;
  title: string;
  status: string;
  progress: number;
  overdue: boolean;
  ownerName?: string | null;
  ownerImage?: string | null;
}

interface RecentProjectsProps {
  projects: DashboardProject[];
}

/**
 * Same card/list shape as the Ticket Dashboard's RecentTickets
 * (components/dashboard/recent-tickets.tsx) — each row's progress bar is
 * the "completion ratio per project" the Projects Dashboard spec asks for,
 * using Project.progress (already reliably maintained via
 * lib/projects/progress-rollup.ts) rather than inventing a new metric.
 */
export function RecentProjects({ projects }: RecentProjectsProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Recent Projects</CardTitle>
        <Link href="/projects" className="text-sm text-primary hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {projects.length === 0 ? (
          <p className="text-center text-muted-foreground py-8 text-sm">
            No projects yet.
          </p>
        ) : (
          <div className="divide-y">
            {projects.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="flex items-start gap-3 px-6 py-3 hover:bg-muted/50 transition-colors"
              >
                <Avatar className="h-8 w-8 mt-0.5 flex-shrink-0">
                  <AvatarImage src={project.ownerImage ?? undefined} />
                  <AvatarFallback className="text-xs">{getInitials(project.ownerName)}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{project.title}</p>
                    {project.overdue && <OverdueBadge />}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="h-1.5 flex-1 max-w-[160px] bg-muted rounded-full">
                      <div className="h-1.5 bg-primary rounded-full" style={{ width: `${project.progress}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-8">{project.progress}%</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
