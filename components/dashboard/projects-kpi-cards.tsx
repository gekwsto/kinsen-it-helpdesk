import { CountStrip } from "@/components/dashboard/count-strip";

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
 * Same ruled count strip as the Ticket Dashboard's KpiCards
 * (components/dashboard/count-strip.tsx) — 7 cells, all clickable.
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
  { key: "totalProjects" as const, label: "Total Projects", sub: "All time", href: "/projects" },
  { key: "activeProjects" as const, label: "Active", sub: "Not yet terminal", href: "/projects?statusGroup=active" },
  { key: "completedProjects" as const, label: "Completed", sub: "Terminal status", href: "/projects?statusGroup=completed" },
  { key: "overdueProjects" as const, label: "Overdue Projects", sub: "Past due date", href: "/projects?overdue=true", attention: true },
  { key: "totalActivities" as const, label: "Total Activities", sub: "All time", href: "/activities" },
  { key: "completedActivities" as const, label: "Completed Activities", sub: "Terminal status", href: "/activities?statusGroup=completed" },
  { key: "overdueActivities" as const, label: "Overdue Activities", sub: "Past due date", href: "/activities?overdue=true", attention: true },
];

export function ProjectsKpiCards(props: ProjectsKpiCardsProps) {
  return <CountStrip items={CARDS.map((c) => ({ ...c, count: props[c.key] }))} />;
}
