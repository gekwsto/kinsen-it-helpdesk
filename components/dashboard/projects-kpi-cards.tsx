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

/** Same 5-card KPI grid pattern as the Ticket Dashboard's KpiCards (components/dashboard/kpi-cards.tsx) — extended to 7 cards (wraps to two rows on smaller widths, same as that component already tolerates). */
const CARDS = [
  { key: "totalProjects" as const, title: "Total Projects", icon: FolderKanban, iconClass: "text-slate-600", bgClass: "bg-slate-100", sub: "All time" },
  { key: "activeProjects" as const, title: "Active", icon: Activity, iconClass: "text-blue-600", bgClass: "bg-blue-50", sub: "Not yet terminal" },
  { key: "completedProjects" as const, title: "Completed", icon: CheckCircle2, iconClass: "text-emerald-600", bgClass: "bg-emerald-50", sub: "Terminal status" },
  { key: "overdueProjects" as const, title: "Overdue Projects", icon: AlertTriangle, iconClass: "text-red-600", bgClass: "bg-red-50", sub: "Past due date" },
  { key: "totalActivities" as const, title: "Total Activities", icon: ListChecks, iconClass: "text-violet-600", bgClass: "bg-violet-50", sub: "All time" },
  { key: "completedActivities" as const, title: "Completed Activities", icon: CheckCircle2, iconClass: "text-emerald-600", bgClass: "bg-emerald-50", sub: "Terminal status" },
  { key: "overdueActivities" as const, title: "Overdue Activities", icon: AlertTriangle, iconClass: "text-red-600", bgClass: "bg-red-50", sub: "Past due date" },
];

export function ProjectsKpiCards(props: ProjectsKpiCardsProps) {
  return (
    <div className="grid gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-7">
      {CARDS.map((card) => (
        <Card key={card.key}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              {card.title}
            </CardTitle>
            <div className={`rounded-lg p-1.5 ${card.bgClass}`}>
              <card.icon className={`h-3.5 w-3.5 ${card.iconClass}`} />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{props[card.key]}</div>
            <p className="text-[11px] text-muted-foreground mt-0.5">{card.sub}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
