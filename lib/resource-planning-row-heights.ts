import { computeRowHeight } from "@/lib/resource-planning-lanes";

/**
 * A department with 2 agents used to leave a large dead strip below a
 * short, natural-height chart; a department with 20 used to force the same
 * fixed per-lane-count height regardless of how much room was actually
 * available. This distributes real leftover vertical space into the
 * resource rows themselves (up to a readable ceiling) BEFORE any of it
 * becomes filler grid — few agents get slightly taller, more comfortable
 * rows; many agents (or agents with many activities) simply use their
 * required height and let the page scroll, exactly as before.
 *
 * Each row's REQUIRED height (enough for its agent info + every activity's
 * own lane + gaps + padding) still comes from computeRowHeight in
 * lib/resource-planning-lanes.ts — this file only decides how any leftover
 * space above that requirement gets distributed; it never touches lane
 * assignment or a row's minimum.
 */
export const MAX_AUTO_EXPANDED_ROW_H = 150;

export interface ResourceHeightInput {
  resourceId: string;
  laneCount: number;
}

export interface ComputeResourceRowHeightsOptions {
  resources: ResourceHeightInput[];
  /** Total vertical space available for the rows area (chart height minus the day-header row) — may be smaller than the rows' combined required height, in which case rows simply use their required height and the page scrolls naturally. */
  availableHeight: number;
  /** Per-row ceiling when distributing leftover space — never shrinks a row below its own required height. */
  maxAutoExpandedRowHeight?: number;
}

export interface ComputeResourceRowHeightsResult {
  /** resourceId -> final rendered row height (px, whole numbers). */
  heightByResourceId: Map<string, number>;
  /** Sum of every row's bare required height (before any distribution). */
  totalRequiredHeight: number;
  /** Sum of every row's final rendered height (>= totalRequiredHeight only due to rounding; distribution never adds more than availableHeight allows). */
  totalRenderedHeight: number;
  /** Leftover space after rows have been expanded as far as their caps (or availableHeight) allow — 0 whenever rows already consume all of availableHeight. */
  fillerHeight: number;
}

/**
 * Water-filling distribution: on each round, split whatever's left evenly
 * across every row that hasn't hit its cap yet; a row that hits its cap
 * mid-round drops out of the next round so its "unused" share effectively
 * flows to the rows still growing. Deterministic (same input -> same
 * output every time) and stable regardless of resource ordering, since
 * every row is offered an equal share each round rather than being
 * processed first-come-first-served.
 */
export function computeResourceRowHeights({
  resources,
  availableHeight,
  maxAutoExpandedRowHeight = MAX_AUTO_EXPANDED_ROW_H,
}: ComputeResourceRowHeightsOptions): ComputeResourceRowHeightsResult {
  const rows = resources.map((r) => {
    const required = computeRowHeight(r.laneCount);
    return { id: r.resourceId, required, current: required, cap: Math.max(required, maxAutoExpandedRowHeight) };
  });

  const totalRequiredHeight = rows.reduce((sum, r) => sum + r.required, 0);
  let remaining = Math.max(0, availableHeight - totalRequiredHeight);

  let active = rows.filter((r) => r.cap - r.current > 0.5);
  while (remaining > 0.5 && active.length > 0) {
    const share = remaining / active.length;
    let usedThisRound = 0;
    const stillActive: typeof active = [];
    for (const r of active) {
      const room = r.cap - r.current;
      const grant = Math.min(share, room);
      r.current += grant;
      usedThisRound += grant;
      if (r.cap - r.current > 0.5) stillActive.push(r);
    }
    remaining -= usedThisRound;
    active = stillActive;
    if (usedThisRound <= 0.5) break; // safety guard — floating-point noise, never an infinite loop
  }

  const heightByResourceId = new Map<string, number>();
  let totalRenderedHeight = 0;
  for (const r of rows) {
    const rounded = Math.round(r.current);
    heightByResourceId.set(r.id, rounded);
    totalRenderedHeight += rounded;
  }

  const fillerHeight = Math.max(0, availableHeight - totalRenderedHeight);

  return { heightByResourceId, totalRequiredHeight, totalRenderedHeight, fillerHeight };
}
