export interface GanttFilterableItem {
  title: string;
  status: string;
  priority?: string | null;
}

export interface GanttFilterableGroup<C extends GanttFilterableItem> extends GanttFilterableItem {
  children: C[];
}

/**
 * Pure combined search + status + priority filtering for the Project Gantt
 * (components/gantt/gantt-chart.tsx) — pulled out of that client component
 * so it's independently testable (no DOM/React needed) and so the Priority
 * filter (Part 1) can never drift from the Status filter's own established
 * behavior, since both are the exact same rule applied twice.
 *
 * Children (activities/milestones) are pruned individually by each active
 * filter; a group (project) survives if it EITHER matches every active
 * filter itself OR still has at least one surviving child — the same
 * "group survives via matching children" rule the Status filter already
 * used before Priority existed. A GanttGroup has no priority field of its
 * own in the general case (see lib/project-priority.ts for how Project's
 * Int priority is mapped onto the same keys so it CAN participate directly
 * too) — when it's null/undefined, a priority filter simply never matches
 * the group itself, identical to how an unset field already behaves for
 * search/status.
 */
export function filterGanttGroups<C extends GanttFilterableItem, G extends GanttFilterableGroup<C>>(
  groups: G[],
  search: string,
  statusFilter: string,
  priorityFilter: string
): G[] {
  const q = search.toLowerCase();
  return groups
    .map((g) => ({
      ...g,
      children: g.children.filter((c) => {
        if (q && !c.title.toLowerCase().includes(q)) return false;
        if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
        if (priorityFilter !== "ALL" && c.priority !== priorityFilter) return false;
        return true;
      }),
    }))
    .filter((g) => {
      if (!q && statusFilter === "ALL" && priorityFilter === "ALL") return true;
      const groupMatch = !q || g.title.toLowerCase().includes(q);
      const statusOk = statusFilter === "ALL" || g.status === statusFilter;
      const priorityOk = priorityFilter === "ALL" || g.priority === priorityFilter;
      return (groupMatch && statusOk && priorityOk) || g.children.length > 0;
    });
}
