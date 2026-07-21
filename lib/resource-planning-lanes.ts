import { comparePriorityDesc } from "@/lib/activity-priority";

export interface LaneableEvent {
  id: string;
  start: string;
  end: string;
  title: string;
  /** ActivityPriority value (or unknown/missing — see activityPriorityRank) — drives the sort below. */
  priority: string;
}

export interface LaneAssignment {
  /** `${resourceId}:${eventId}` -> lane index (0-based). */
  laneByKey: Map<string, number>;
  /** resourceId -> number of lanes actually used (always >= 1). */
  laneCountByResource: Map<string, number>;
}

// Row/lane geometry constants — shared between resource-timeline.tsx (which
// positions each lane's bar via LANE_TOP + lane * (BAR_H + LANE_GAP)) and
// computeRowHeight below, so the two can never drift out of sync.
export const BAR_H = 22; // visible bar height (also the drag hitbox height)
export const LANE_GAP = 6; // vertical breathing room between stacked lanes
export const LANE_TOP = 10; // top/bottom padding within a row, before the first lane / after the last
export const BASE_ROW_H = 68; // floor for a 1-lane row (keeps the Agent info column readable even with a short avatar+name+badge stack)

/** A row's rendered height must grow to fit however many lanes its activities actually need — never a fixed height that would force lanes back into overlapping each other. */
export function computeRowHeight(laneCount: number): number {
  return Math.max(BASE_ROW_H, LANE_TOP + laneCount * BAR_H + Math.max(0, laneCount - 1) * LANE_GAP + LANE_TOP);
}

/**
 * One dedicated lane per activity, per resource row — deliberately NOT
 * interval-packing/overlap minimization. An earlier version of this
 * function greedily packed events into the smallest number of lanes
 * (reusing a lane once its previous occupant's date range ended), which is
 * exactly why activities used to visually share/crowd into 1-2 lanes even
 * when a resource had several of them — a compact but visually confusing
 * result the same-resource-row concept was never meant to trade clarity
 * for. Every activity now gets its own permanent lane for as long as it's
 * in this resource's row, full stop — row height (computeRowHeight above)
 * simply grows to fit however many there are.
 *
 * Lane order is priority-first (URGENT..LOW via
 * lib/activity-priority.ts's canonical rank — NOT the schema's own
 * LOW..URGENT declaration order), then start date, then title/id as a
 * fully deterministic tiebreak — lane 0 is always the single most urgent
 * activity for that resource, rendered at the top of its row. This still
 * needs to be a stable, deterministic assignment (same input -> same
 * lanes on every render) since dragging relies on each activity keeping a
 * distinct, unchanging screen position mid-gesture — see barKey in
 * resource-timeline.tsx, which disambiguates DOM refs per (resource,
 * activity) pair and is unaffected by this file's algorithm either way.
 */
export function assignLanes(eventsByResource: Map<string, LaneableEvent[]>): LaneAssignment {
  const laneByKey = new Map<string, number>();
  const laneCountByResource = new Map<string, number>();

  for (const [resourceId, resourceEvents] of eventsByResource) {
    const sorted = [...resourceEvents].sort(
      (a, b) =>
        comparePriorityDesc(a.priority, b.priority) ||
        new Date(a.start).getTime() - new Date(b.start).getTime() ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id)
    );
    sorted.forEach((e, index) => {
      laneByKey.set(`${resourceId}:${e.id}`, index);
    });
    laneCountByResource.set(resourceId, Math.max(1, sorted.length));
  }

  return { laneByKey, laneCountByResource };
}
