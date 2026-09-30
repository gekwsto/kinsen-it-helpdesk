import { ActivityPriority } from "@prisma/client";
import { PriorityMark, titleCase } from "@/components/shared/marks";

/**
 * Color mapping per ActivityPriority — single source of truth, moved here
 * from components/activities/activity-card.tsx (which still imports it from
 * here for its OWN, deliberately different, Card-view badge). Reused by the
 * Activity List view AND the Project List view: Project's own priority is a
 * plain 1-3 Int (a fixed, non-configurable correspondence — see
 * lib/project-priority.ts's projectPriorityKey), never a second/independent
 * color mapping.
 */
export const PRIORITY_COLORS: Record<ActivityPriority, string> = {
  LOW: "bg-green-50 text-green-700",
  MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700",
  URGENT: "bg-red-50 text-red-700",
};

interface PriorityBadgeProps {
  /**
   * `null` renders a clean, non-colored empty-state dash instead of a
   * pill — used by a Project row whose Int priority falls outside the
   * mapped 1-3 range (projectPriorityKey's own defensive fallback for a
   * stale/legacy value). Activity's own `priority` is a required enum and
   * never passes null here in real use; this is purely Project's edge case,
   * handled the same clean/muted way every other empty cell in these two
   * list views already is (e.g. the Date range column's own "—").
   */
  priority: ActivityPriority | null;
}

/**
 * The exact small colored pill the Activity List view's Priority column
 * already rendered inline (text-xs font-medium px-2 py-0.5 rounded-full +
 * PRIORITY_COLORS, raw enum value as the label — no extra "Priority" text,
 * never two lines) — extracted here unchanged so the Project List view's
 * own Priority column can render an IDENTICAL badge for the same priority
 * value, instead of its previous two-line outlined "Priority {Label}" pill.
 * Deliberately NOT used by ActivityCard's own Card-view priority badge
 * (`<Badge variant="outline" className="... border-0 ...">`) — that's a
 * different, existing visual this task does not touch.
 */
const PRIORITY_RANK: Record<ActivityPriority, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };

// Tailwind colour class -> the mark's fill, so the bars match the existing
// PRIORITY_COLORS palette ActivityCard still uses.
const PRIORITY_MARK_COLOR: Record<ActivityPriority, string> = {
  LOW: "#15803d",
  MEDIUM: "#a16207",
  HIGH: "#c2410c",
  URGENT: "#b91c1c",
};

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  if (!priority) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return <PriorityMark label={titleCase(priority)} rank={PRIORITY_RANK[priority]} color={PRIORITY_MARK_COLOR[priority]} />;
}
