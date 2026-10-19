import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FolderKanban,
  Activity,
  CheckCircle2,
  AlertTriangle,
  ListChecks,
} from "lucide-react";

interface ProjectsKpiCardsProps {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  overdueProjects: number;
  totalActivities: number;
  completedActivities: number;
  overdueActivities: number;
}

/**
 * Same 5-card KPI grid pattern as the Ticket Dashboard's KpiCards
 * (components/dashboard/kpi-cards.tsx) — extended to 7 cards, all clickable.
 * The 4 project-count cards link to the All Projects list, resolved by
 * lib/services/project-query-service.ts. The 3 activity-count cards link to
 * the All Activities list (app/(main)/activities/page.tsx) — a real
 * cross-project activity list, resolved by the analogous
 * lib/services/activity-query-service.ts — never to the project list, which
 * would silently disagree (a project count is never equal to an activity
 * count). Every card's `href` query contract is resolved by the exact same
 * shared helpers this card's own count comes from, so a card's number and
 * what clicking it shows can never disagree.
 */
const CARDS = [
  { key: "totalProjects" as const, title: "Total Projects", icon: FolderKanban, iconClass: "text-slate-600 dark:text-slate-400", bgClass: "bg-slate-100 dark:bg-slate-800/60", accentClass: "bg-slate-400 dark:bg-slate-500", sub: "All time", href: "/projects", ariaLabel: "View all projects" },
  { key: "activeProjects" as const, title: "Active", icon: Activity, iconClass: "text-blue-600 dark:text-blue-400", bgClass: "bg-blue-50 dark:bg-blue-900/20", accentClass: "bg-blue-500", sub: "Not yet terminal", href: "/projects?statusGroup=active", ariaLabel: "View active projects" },
  { key: "completedProjects" as const, title: "Completed", icon: CheckCircle2, iconClass: "text-emerald-600 dark:text-emerald-400", bgClass: "bg-emerald-50 dark:bg-emerald-900/20", accentClass: "bg-emerald-500", sub: "Terminal status", href: "/projects?statusGroup=completed", ariaLabel: "View completed projects" },
  { key: "overdueProjects" as const, title: "Overdue Projects", icon: AlertTriangle, iconClass: "text-red-600 dark:text-red-400", bgClass: "bg-red-50 dark:bg-red-900/20", accentClass: "bg-red-500", sub: "Past due date", href: "/projects?overdue=true", ariaLabel: "View overdue projects" },
  { key: "totalActivities" as const, title: "Total Activities", icon: ListChecks, iconClass: "text-violet-600 dark:text-violet-400", bgClass: "bg-violet-50 dark:bg-violet-900/20", accentClass: "bg-violet-500", sub: "All time", href: "/activities", ariaLabel: "View all activities" },
  { key: "completedActivities" as const, title: "Completed Activities", icon: CheckCircle2, iconClass: "text-emerald-600 dark:text-emerald-400", bgClass: "bg-emerald-50 dark:bg-emerald-900/20", accentClass: "bg-emerald-500", sub: "Terminal status", href: "/activities?statusGroup=completed", ariaLabel: "View completed activities" },
  { key: "overdueActivities" as const, title: "Overdue Activities", icon: AlertTriangle, iconClass: "text-red-600 dark:text-red-400", bgClass: "bg-red-50 dark:bg-red-900/20", accentClass: "bg-red-500", sub: "Past due date", href: "/activities?overdue=true", ariaLabel: "View overdue activities" },
];

export function ProjectsKpiCards(props: ProjectsKpiCardsProps) {
  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
      {CARDS.map((card) => {
        const body = (
          <Card className={card.href ? "relative h-full overflow-hidden rounded-xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:border-primary/40 cursor-pointer" : "relative h-full overflow-hidden rounded-xl"}>
            <div className={`absolute inset-x-0 top-0 h-1 ${card.accentClass}`} />
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                {card.title}
              </CardTitle>
              <div className={`rounded-xl p-2 ${card.bgClass}`}>
                <card.icon className={`h-4 w-4 ${card.iconClass}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{props[card.key]}</div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{card.sub}</p>
            </CardContent>
          </Card>
        );

        if (!card.href) {
          return <div key={card.key}>{body}</div>;
        }

        return (
          <Link
            key={card.key}
            href={card.href}
            aria-label={card.ariaLabel}
            className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {body}
          </Link>
        );
      })}
    </div>
  );
}
