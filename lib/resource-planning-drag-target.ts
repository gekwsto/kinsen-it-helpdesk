/**
 * Resource Planning drag-and-drop to a DIFFERENT resource row (reassign the
 * activity) — previously unimplemented entirely (the drag code only ever
 * translated horizontally; there was no row hit-testing, and the PATCH body
 * never included assignedUserIds). Pulled out as pure functions, same
 * reasoning as the other lib/resource-planning-*.ts modules: no DOM/React
 * dependency, so this can be unit-tested directly rather than only via a
 * pointer-event/DOM simulation this codebase has no library for.
 *
 * The component (resource-timeline.tsx) snapshots each ELIGIBLE row's
 * screen-space bounding box once at drag-start (only rows for a resource
 * that's actually a valid activity-assignment target — see
 * `assignableFor` on ResourcePlanningResource — are included, so hovering
 * an ineligible row simply never registers as a target at all, no separate
 * "invalid" visual state needed) and calls findHoveredResourceId on every
 * pointer move to decide which row (if any) is currently under the
 * pointer — deliberately NOT a live DOM query per move (that would mean
 * measuring every row's layout on every pointermove, expensive and a
 * violation of this component's established zero-layout-thrash drag
 * philosophy).
 */
export interface RowBound {
  resourceId: string;
  top: number;
  bottom: number;
}

/** Which (eligible) row's vertical span currently contains clientY, if any. */
export function findHoveredResourceId(rowBounds: RowBound[], clientY: number): string | null {
  const hit = rowBounds.find((r) => clientY >= r.top && clientY <= r.bottom);
  return hit ? hit.resourceId : null;
}

/** True only when the pointer ended up over a DIFFERENT eligible row than the one the drag started in — a row-bounds miss (null) or landing back on the origin row is never a reassignment. */
export function isReassignment(originResourceId: string, hoveredResourceId: string | null): boolean {
  return hoveredResourceId !== null && hoveredResourceId !== originResourceId;
}

export type DragOutcome = "click" | "no-op" | "move";

/**
 * Generalizes the pre-existing "<5px = click" rule to two dimensions: a
 * drag that barely moved on EITHER axis and didn't cross into a different
 * row is a click (opens the activity), not a drag — a purely-vertical
 * reassign-only gesture (no horizontal movement at all) must NOT be
 * swallowed as a click just because its horizontal component was small.
 * Similarly, "no date change" only means no-op when the row didn't change
 * either — a same-day drop onto a different row is still a real
 * reassignment, not a no-op.
 */
export function resolveDragOutcome(params: {
  totalMovementPx: number;
  daysDelta: number;
  originResourceId: string;
  hoveredResourceId: string | null;
}): DragOutcome {
  const crossedRow = isReassignment(params.originResourceId, params.hoveredResourceId);
  if (params.totalMovementPx < 5 && !crossedRow) return "click";
  if (params.daysDelta === 0 && !crossedRow) return "no-op";
  return "move";
}
