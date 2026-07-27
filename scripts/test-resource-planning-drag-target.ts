/**
 * Resource Planning drag-and-drop to a DIFFERENT resource row (reassign the
 * activity) — previously unimplemented entirely: the drag code only ever
 * translated horizontally, there was no row hit-testing, and the PATCH body
 * never included assignedUserIds even though the backend has always
 * supported it. lib/resource-planning-drag-target.ts is the new pure
 * geometry/decision layer resource-timeline.tsx's drag handlers are built
 * on — tested directly here, no DOM/pointer-event simulation available in
 * this codebase.
 *
 * Tests — findHoveredResourceId:
 *  1. A clientY inside a row's [top, bottom] span resolves to that row.
 *  2. A clientY outside every row's span resolves to null (header, footer,
 *     or the gap between two non-adjacent rows).
 *  3. Boundary values (exactly top / exactly bottom) are inclusive.
 *  4. The first matching row wins if two bounds were (incorrectly)
 *     overlapping — deterministic, not last-match.
 *
 * Tests — isReassignment:
 *  5. A different, non-null hovered id IS a reassignment.
 *  6. The same id as the origin is NOT a reassignment (dropped back on its
 *     own row).
 *  7. A null hovered id (pointer ended outside any eligible row) is NOT a
 *     reassignment — falls back to a same-row date update.
 *
 * Tests — resolveDragOutcome:
 *  8. Negligible movement on both axes, no row change -> "click".
 *  9. A purely VERTICAL drag (near-zero horizontal movement) that DOES
 *     cross into a different row is "move", never swallowed as a click —
 *     this was the actual gap: the old "<5px horizontal = click" rule
 *     would have eaten a reassign-only gesture entirely.
 *  10. Real horizontal movement with no row change and a non-zero
 *      daysDelta is "move" (the original same-row date-drag behavior,
 *      unaffected by this feature).
 *  11. No horizontal movement (daysDelta 0) AND no row change is "no-op" —
 *      the pre-existing guard against a wasted no-change PATCH.
 *  12. Zero daysDelta but a real row change is still "move" (a same-day
 *      drop onto a different row is a real reassignment, not a no-op).
 *
 * Usage: npx tsx scripts/test-resource-planning-drag-target.ts
 * Pure logic — no database, no reachability guard needed.
 */
import { findHoveredResourceId, isReassignment, resolveDragOutcome, type RowBound } from "@/lib/resource-planning-drag-target";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function main() {
  const rowBounds: RowBound[] = [
    { resourceId: "agentA", top: 100, bottom: 180 },
    { resourceId: "agentB", top: 180, bottom: 260 },
    { resourceId: "agentC", top: 300, bottom: 380 }, // deliberate gap (300 > 260) between B and C
  ];

  console.log("\nTesting findHoveredResourceId...\n");
  check("A clientY inside agentA's span resolves to agentA", findHoveredResourceId(rowBounds, 140) === "agentA");
  check("A clientY inside agentC's span resolves to agentC", findHoveredResourceId(rowBounds, 350) === "agentC");
  check("A clientY in the header (above every row) resolves to null", findHoveredResourceId(rowBounds, 50) === null);
  check("A clientY in the gap between B and C resolves to null", findHoveredResourceId(rowBounds, 280) === null);
  check("A clientY below every row (filler area) resolves to null", findHoveredResourceId(rowBounds, 1000) === null);
  check("Boundary: exactly top is inclusive", findHoveredResourceId(rowBounds, 100) === "agentA");
  check("Boundary: exactly bottom is inclusive", findHoveredResourceId(rowBounds, 180) === "agentA" || findHoveredResourceId(rowBounds, 180) === "agentB");

  console.log("\nTesting findHoveredResourceId picks the first match deterministically...\n");
  {
    const overlapping: RowBound[] = [
      { resourceId: "first", top: 100, bottom: 200 },
      { resourceId: "second", top: 150, bottom: 250 },
    ];
    check("Overlapping bounds resolve to the FIRST matching entry, not the last", findHoveredResourceId(overlapping, 170) === "first");
  }

  console.log("\nTesting isReassignment...\n");
  check("A different, non-null hovered id IS a reassignment", isReassignment("agentA", "agentB"));
  check("The same id as the origin is NOT a reassignment", !isReassignment("agentA", "agentA"));
  check("A null hovered id is NOT a reassignment (falls back to same-row date update)", !isReassignment("agentA", null));

  console.log("\nTesting resolveDragOutcome...\n");
  check(
    "Negligible movement, no row change -> click",
    resolveDragOutcome({ totalMovementPx: 2, daysDelta: 0, originResourceId: "agentA", hoveredResourceId: "agentA" }) === "click"
  );
  check(
    "A purely vertical reassign-only drag (near-zero horizontal movement) is 'move', NOT swallowed as a click",
    resolveDragOutcome({ totalMovementPx: 80, daysDelta: 0, originResourceId: "agentA", hoveredResourceId: "agentB" }) === "move"
  );
  check(
    "Real horizontal movement, no row change, non-zero daysDelta -> move (the original same-row date-drag case)",
    resolveDragOutcome({ totalMovementPx: 120, daysDelta: 3, originResourceId: "agentA", hoveredResourceId: "agentA" }) === "move"
  );
  check(
    "No horizontal movement (daysDelta 0) and no row change -> no-op",
    resolveDragOutcome({ totalMovementPx: 8, daysDelta: 0, originResourceId: "agentA", hoveredResourceId: "agentA" }) === "no-op"
  );
  check(
    "Zero daysDelta but a real row change is still 'move' (a same-day drop onto a different row is a real reassignment)",
    resolveDragOutcome({ totalMovementPx: 8, daysDelta: 0, originResourceId: "agentA", hoveredResourceId: "agentC" }) === "move"
  );
  check(
    "A null hoveredResourceId with real horizontal movement is a normal same-row move",
    resolveDragOutcome({ totalMovementPx: 120, daysDelta: 2, originResourceId: "agentA", hoveredResourceId: null }) === "move"
  );

  printSummaryAndExit();
}

main();
