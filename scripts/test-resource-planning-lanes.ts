/**
 * Resource Planning lane model, twice-revised now:
 *
 * Phase 1 fixed a drag-target bug (dragging the top event sometimes moved
 * the one underneath) caused by an `idx % 2` lane alternation that didn't
 * check date overlap at all.
 *
 * Phase 2 replaced that with greedy interval-partitioning ("minimum
 * meeting rooms") — events only shared a lane if their date ranges didn't
 * overlap, otherwise each got its own.
 *
 * This phase replaces interval-partitioning too: the explicit product ask
 * is one dedicated lane per activity, always — no more sharing/reusing a
 * lane just because two activities happen not to overlap in time. A
 * resource with 4 activities now always renders 4 distinct lanes, full
 * stop, ordered by canonical priority (URGENT..LOW — see
 * lib/activity-priority.ts) then start date then title/id as a
 * deterministic tiebreak, so the most urgent activity for a resource is
 * always lane 0 (rendered at the top of that resource's row).
 *
 * This remains pure layout logic with no DOM/React dependency, tested
 * directly here rather than via a pointer-event/DOM simulation (this
 * codebase has no jsdom/testing-library dependency, and adding one solely
 * for this would be overkill).
 *
 * Tests — assignLanes() one-per-lane model:
 *  1. Two activities for the same resource always get two distinct lanes,
 *     regardless of whether their date ranges overlap (the core behavior
 *     change from interval-partitioning).
 *  2. laneCountByResource always equals the resource's activity count.
 *  3. Higher-priority activities get lower lane indices (URGENT before
 *     HIGH before MEDIUM before LOW) even when a lower-priority activity
 *     starts earlier — priority is the primary sort key.
 *  4. Within the same priority, earlier start date gets the lower lane.
 *  5. Same priority AND same start date falls back to a deterministic
 *     title/id tiebreak (never arbitrary/unstable across renders).
 *  6. Lane assignment is independent per resource (the same activity
 *     assigned to two different agents gets an independent lane in each
 *     row, matching how a multi-assignee activity renders once per row).
 *  7. Unknown/missing priority values sort after LOW, never crash.
 *  8. Empty input resolves to a lane count of 1 (never 0) — matches the
 *     render layer's own "at least one row-height's worth of space" floor.
 *
 * Also covers the companion "event drags into the Agent column" bug fix —
 * clampDragDelta() (lib/resource-planning-drag-bounds.ts):
 *  9. A leftward drag within bounds passes through unclamped.
 *  10. A leftward drag past the grid's left edge is clamped so the bar's
 *      effective left never goes negative (never enters the Agent column).
 *  11. A bar already sitting at the left edge (originalLeft: 0) clamps any
 *      further leftward attempt to exactly 0.
 *  12. A rightward drag past the grid's right edge is clamped so the bar's
 *      effective right never exceeds totalWidth.
 *  13. A rightward drag within bounds passes through unclamped.
 *
 * Also covers computeRowHeight() (lib/resource-planning-lanes.ts) — a
 * row's height must grow with however many activities (now always ==
 * lane count) a resource actually has, never a fixed/hardcoded height:
 *  14. Row height grows monotonically as lane count increases.
 *  15. A 1-lane row is exactly the base row height floor.
 *
 * Usage: npx tsx scripts/test-resource-planning-lanes.ts
 * Pure logic — no database, no reachability guard needed.
 */
import { assignLanes, computeRowHeight, BASE_ROW_H, type LaneableEvent } from "@/lib/resource-planning-lanes";
import { clampDragDelta } from "@/lib/resource-planning-drag-bounds";

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

function ev(id: string, start: string, end: string, priority = "MEDIUM", title = id): LaneableEvent {
  return { id, start, end, title, priority };
}

function main() {
  console.log("\nTesting every activity gets its own lane, overlapping or not...\n");
  {
    // Non-overlapping dates — the old interval-packing model would have
    // put both in lane 0. The new model never shares a lane, period.
    const { laneByKey, laneCountByResource } = assignLanes(
      new Map([["agentA", [ev("e1", "2026-08-01", "2026-08-03"), ev("e2", "2026-08-10", "2026-08-12")]]])
    );
    const lane1 = laneByKey.get("agentA:e1");
    const lane2 = laneByKey.get("agentA:e2");
    check("Both activities got a lane assigned", lane1 !== undefined && lane2 !== undefined);
    check("Non-overlapping activities STILL get distinct lanes (no sharing)", lane1 !== lane2);
    check("2 lanes used for 2 activities", laneCountByResource.get("agentA") === 2);
  }

  console.log("\nTesting lane count always equals activity count for that resource...\n");
  {
    const { laneCountByResource } = assignLanes(
      new Map([
        [
          "agentA",
          [
            ev("e1", "2026-08-01", "2026-08-02"),
            ev("e2", "2026-08-01", "2026-08-02"),
            ev("e3", "2026-08-01", "2026-08-02"),
            ev("e4", "2026-09-01", "2026-09-02"), // not even overlapping the others
          ],
        ],
      ])
    );
    check("4 activities -> 4 lanes, regardless of overlap", laneCountByResource.get("agentA") === 4);
  }

  console.log("\nTesting priority is the primary sort key (most urgent gets the top lane)...\n");
  {
    // "low" starts first chronologically but is LOW priority; "urgent"
    // starts later but is URGENT — urgent must still land in lane 0.
    const { laneByKey } = assignLanes(
      new Map([
        [
          "agentA",
          [
            ev("low", "2026-08-01", "2026-08-05", "LOW"),
            ev("urgent", "2026-08-10", "2026-08-15", "URGENT"),
            ev("medium", "2026-08-03", "2026-08-04", "MEDIUM"),
            ev("high", "2026-08-20", "2026-08-25", "HIGH"),
          ],
        ],
      ])
    );
    check("URGENT is lane 0 despite starting later than LOW/MEDIUM", laneByKey.get("agentA:urgent") === 0);
    check("HIGH is lane 1", laneByKey.get("agentA:high") === 1);
    check("MEDIUM is lane 2", laneByKey.get("agentA:medium") === 2);
    check("LOW is lane 3, last, despite starting first", laneByKey.get("agentA:low") === 3);
  }

  console.log("\nTesting start date is the secondary sort key within the same priority...\n");
  {
    const { laneByKey } = assignLanes(
      new Map([
        [
          "agentA",
          [
            ev("later", "2026-08-10", "2026-08-12", "HIGH"),
            ev("earlier", "2026-08-01", "2026-08-03", "HIGH"),
          ],
        ],
      ])
    );
    check("Earlier-starting same-priority activity gets the lower lane", laneByKey.get("agentA:earlier") === 0);
    check("Later-starting same-priority activity gets the higher lane", laneByKey.get("agentA:later") === 1);
  }

  console.log("\nTesting title/id is a deterministic final tiebreak...\n");
  {
    const { laneByKey } = assignLanes(
      new Map([
        [
          "agentA",
          [
            ev("z-id", "2026-08-01", "2026-08-03", "MEDIUM", "Zebra task"),
            ev("a-id", "2026-08-01", "2026-08-03", "MEDIUM", "Alpha task"),
          ],
        ],
      ])
    );
    check("Same priority AND same start date sorts by title — 'Alpha' before 'Zebra'", laneByKey.get("agentA:a-id") === 0);
    check("...and is stable/repeatable, not arbitrary", laneByKey.get("agentA:z-id") === 1);
  }

  console.log("\nTesting lane assignment is independent per resource...\n");
  {
    const shared = [ev("shared1", "2026-08-01", "2026-08-05", "LOW"), ev("shared2", "2026-08-02", "2026-08-04", "URGENT")];
    const { laneByKey, laneCountByResource } = assignLanes(
      new Map([
        ["agentA", shared],
        ["agentB", [ev("solo", "2026-08-01", "2026-08-05")]],
      ])
    );
    check("agentA: URGENT (shared2) is lane 0 despite starting later", laneByKey.get("agentA:shared2") === 0);
    check("agentA: LOW (shared1) is lane 1", laneByKey.get("agentA:shared1") === 1);
    check("agentB's single activity is lane 0, unaffected by agentA's row", laneByKey.get("agentB:solo") === 0);
    check("agentA uses 2 lanes", laneCountByResource.get("agentA") === 2);
    check("agentB uses 1 lane", laneCountByResource.get("agentB") === 1);
  }

  console.log("\nTesting unknown/missing priority sorts after LOW without crashing...\n");
  {
    const { laneByKey } = assignLanes(
      new Map([
        [
          "agentA",
          [
            ev("lowPriority", "2026-08-01", "2026-08-02", "LOW"),
            ev("unknownPriority", "2026-08-01", "2026-08-02", "" /* unexpected/empty */),
          ],
        ],
      ])
    );
    check("LOW ranks above an unknown/empty priority value", laneByKey.get("agentA:lowPriority") === 0);
    check("Unknown priority still gets a lane, doesn't throw", laneByKey.get("agentA:unknownPriority") === 1);
  }

  console.log("\nTesting the empty-row floor...\n");
  {
    const { laneCountByResource } = assignLanes(new Map([["agentA", []]]));
    check("An agent with zero activities still reports a lane count of 1 (never 0)", laneCountByResource.get("agentA") === 1);
  }

  console.log("\nTesting clampDragDelta — the event-enters-Agent-column bug fix...\n");
  {
    // Bar sits at left=300 (well inside a 1000px-wide grid), width=100.
    const originalLeft = 300;
    const barWidth = 100;
    const totalWidth = 1000;

    check(
      "A small leftward drag within bounds passes through unclamped",
      clampDragDelta(originalLeft, barWidth, totalWidth, -50) === -50
    );
    check(
      "A leftward drag past the left edge is clamped to exactly -originalLeft",
      clampDragDelta(originalLeft, barWidth, totalWidth, -1000) === -originalLeft
    );
    check(
      "A bar already at the left edge (originalLeft=0) clamps any further left attempt to 0",
      clampDragDelta(0, barWidth, totalWidth, -50) === 0
    );
    check(
      "A rightward drag past the right edge is clamped so effective right === totalWidth",
      originalLeft + clampDragDelta(originalLeft, barWidth, totalWidth, 5000) + barWidth === totalWidth
    );
    check(
      "A small rightward drag within bounds passes through unclamped",
      clampDragDelta(originalLeft, barWidth, totalWidth, 50) === 50
    );
  }

  console.log("\nTesting computeRowHeight grows with lane count...\n");
  {
    const h1 = computeRowHeight(1);
    const h2 = computeRowHeight(2);
    const h3 = computeRowHeight(4);
    check("1-lane row equals the base row height floor", h1 === BASE_ROW_H);
    check("2-lane row is taller than 1-lane", h2 > h1);
    check("4-lane row (e.g. a resource with 4 activities) is taller than 2-lane", h3 > h2);
    check("Zero/negative lane counts still floor at the base row height", computeRowHeight(0) === BASE_ROW_H);
  }

  printSummaryAndExit();
}

main();
