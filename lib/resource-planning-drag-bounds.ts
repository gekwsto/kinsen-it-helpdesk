/**
 * Clamps a Resource Planning timeline drag's horizontal pixel delta so an
 * event bar's effective position never leaves the date-grid's own
 * coordinate space (which starts at 0 and excludes the Agent column's own
 * width entirely — see LEFT_W in resource-timeline.tsx). Without this, a
 * bar dragged far enough left visually slid over the Agent column, and
 * dragged far enough right slid past the last loaded day column, because
 * the raw pointer delta was applied to the transform with no bound at all.
 *
 * Pulled out of the "use client" component (which also imports
 * next/navigation, sonner, etc. — none of which run in a plain node/tsx
 * test script) so this bit of pure math is unit-testable the same way every
 * other pure computation in this codebase is — see
 * scripts/test-resource-planning-lanes.ts.
 */
export function clampDragDelta(
  originalLeft: number,
  barWidth: number,
  totalWidth: number,
  rawDelta: number
): number {
  const minDelta = -originalLeft; // effective left (originalLeft + delta) must stay >= 0
  const maxDelta = Math.max(minDelta, totalWidth - barWidth - originalLeft); // effective right must stay <= totalWidth
  return Math.min(maxDelta, Math.max(minDelta, rawDelta));
}
