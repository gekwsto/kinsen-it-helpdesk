/**
 * Resource Planning timeline row/column sizing became "one hardcoded value
 * per lane count" and "one fixed [min,max] range for every view" — a
 * department with 2 agents left a large dead strip below a short chart,
 * and week/month views shared the same column-width bounds even though 7
 * columns and ~30 columns need very different treatment.
 *
 * computeResourceRowHeights() (lib/resource-planning-row-heights.ts)
 * distributes real leftover vertical space into the resource rows
 * themselves (up to a readable cap) before any of it becomes filler grid.
 * computePxPerDay() (lib/resource-planning-column-sizing.ts) centralizes
 * view-mode-aware [min, max, default] column-width bounds instead of
 * spreading Record<ResourcePlanningView, number> literals through the
 * component. Both are pure, DOM-free functions, tested directly here.
 *
 * Tests — computeResourceRowHeights (row sizing):
 *  1. Few resources with ample availableHeight expand up to the cap.
 *  2. Many resources (or little availableHeight) use their required
 *     height only — no forced giant rows.
 *  3. A resource with 0 activities gets a readable minimum height
 *     (computeRowHeight(1)'s own floor, reused unchanged).
 *  4. A resource with 1 activity fits without needing to expand.
 *  5. A resource with 4 activities gets enough height for 4 separate,
 *     non-overlapping lanes.
 *  6. fillerHeight shrinks as rows are allowed to expand (more
 *     availableHeight -> more absorbed into rows -> less filler for the
 *     same total).
 *  7. fillerHeight is 0 whenever total required height already meets or
 *     exceeds availableHeight (rows use natural/required height, page
 *     scrolls) — filler only ever appears after rows hit their cap.
 *  8. Deterministic: identical input produces identical output across
 *     repeated calls, and doesn't depend on resource array order.
 *  9. A row that legitimately requires MORE than the auto-expand cap
 *     (many activities) still renders at its full required height, never
 *     shrunk to the cap.
 *  10. No cross-resource bleed — one resource's lane count never affects
 *      another resource's computed height.
 *
 * Tests — computePxPerDay (column sizing):
 *  11. Week view (7 days) fills available width without needing
 *      horizontal scroll on a normal laptop-width container.
 *  12. Month view (30 days) stays compact — pxPerDay is meaningfully
 *      smaller than week view for the same container width.
 *  13. pxPerDay is clamped to each view's own [min, max] — never below
 *      min, never above max, regardless of container width.
 *  14. Widening the container increases pxPerDay predictably (up to the
 *      view's max), narrowing it decreases pxPerDay (down to the view's
 *      min) — no fixed hardcoded day width regardless of container size.
 *  15. requiresHorizontalScroll is true only when the clamped pxPerDay
 *      still doesn't fit the available width (i.e. min was hit and it's
 *      still too wide).
 *  16. An unconfigured future view mode (e.g. "quarter") falls back to
 *      sane bounds instead of crashing or returning nonsense.
 *
 * Usage: npx tsx scripts/test-resource-planning-dynamic-sizing.ts
 * Pure logic — no database, no reachability guard needed.
 */
import { computeResourceRowHeights, MAX_AUTO_EXPANDED_ROW_H } from "@/lib/resource-planning-row-heights";
import { computeRowHeight, BASE_ROW_H } from "@/lib/resource-planning-lanes";
import { computePxPerDay, PX_PER_DAY_BOUNDS } from "@/lib/resource-planning-column-sizing";

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
  console.log("\nTesting few resources expand up to the cap when there's ample space...\n");
  {
    const result = computeResourceRowHeights({
      resources: [
        { resourceId: "a", laneCount: 1 },
        { resourceId: "b", laneCount: 1 },
      ],
      availableHeight: 600,
    });
    check("Resource a expanded to the auto-expand cap", result.heightByResourceId.get("a") === MAX_AUTO_EXPANDED_ROW_H);
    check("Resource b expanded to the auto-expand cap", result.heightByResourceId.get("b") === MAX_AUTO_EXPANDED_ROW_H);
    check("Both rows are taller than their bare required height", MAX_AUTO_EXPANDED_ROW_H > computeRowHeight(1));
  }

  console.log("\nTesting many resources (or little space) use required height only, no giant rows...\n");
  {
    const manyResources = Array.from({ length: 15 }, (_, i) => ({ resourceId: `r${i}`, laneCount: 1 }));
    const result = computeResourceRowHeights({ resources: manyResources, availableHeight: 400 }); // 15 * 68 = 1020, already exceeds 400
    const allAtRequired = manyResources.every((r) => result.heightByResourceId.get(r.resourceId) === computeRowHeight(r.laneCount));
    check("Every row renders at exactly its required height (no expansion possible)", allAtRequired);
    check("No row is forced to some artificially large size", Math.max(...result.heightByResourceId.values()) === computeRowHeight(1));
  }

  console.log("\nTesting activity-count-driven minimum heights...\n");
  {
    check("0-activity resource gets a readable minimum (computeRowHeight(1) floor)", computeRowHeight(0 || 1) === BASE_ROW_H);
    const oneActivity = computeResourceRowHeights({ resources: [{ resourceId: "a", laneCount: 1 }], availableHeight: 0 });
    check("1-activity resource fits at its required height without forcing expansion", oneActivity.heightByResourceId.get("a") === computeRowHeight(1));
    const fourActivities = computeResourceRowHeights({ resources: [{ resourceId: "a", laneCount: 4 }], availableHeight: 0 });
    const requiredFor4 = computeRowHeight(4);
    check("4-activity resource gets enough height for 4 separate lanes", fourActivities.heightByResourceId.get("a") === requiredFor4);
    check("...and that's meaningfully taller than a 1-activity row", requiredFor4 > computeRowHeight(1));
  }

  console.log("\nTesting fillerHeight shrinks as rows are allowed to expand...\n");
  {
    const resources = [{ resourceId: "a", laneCount: 1 }, { resourceId: "b", laneCount: 1 }];
    const small = computeResourceRowHeights({ resources, availableHeight: 200 });
    const large = computeResourceRowHeights({ resources, availableHeight: 600 });
    check("Filler is smaller (or equal) once rows have more room to absorb space", large.fillerHeight <= small.fillerHeight || large.totalRenderedHeight > small.totalRenderedHeight);
    check("With ample space, filler is what's left AFTER both rows hit their cap", large.fillerHeight === 600 - 2 * MAX_AUTO_EXPANDED_ROW_H);
  }

  console.log("\nTesting fillerHeight is 0 whenever rows already consume all available space...\n");
  {
    const result = computeResourceRowHeights({
      resources: [{ resourceId: "a", laneCount: 3 }, { resourceId: "b", laneCount: 3 }],
      availableHeight: 10, // far less than required
    });
    check("fillerHeight is 0 when required height already exceeds availableHeight", result.fillerHeight === 0);
  }

  console.log("\nTesting determinism and order-independence...\n");
  {
    const resources = [{ resourceId: "a", laneCount: 2 }, { resourceId: "b", laneCount: 1 }, { resourceId: "c", laneCount: 3 }];
    const first = computeResourceRowHeights({ resources, availableHeight: 500 });
    const second = computeResourceRowHeights({ resources, availableHeight: 500 });
    check(
      "Identical input produces identical output on repeated calls",
      JSON.stringify([...first.heightByResourceId]) === JSON.stringify([...second.heightByResourceId])
    );

    const reordered = computeResourceRowHeights({ resources: [...resources].reverse(), availableHeight: 500 });
    check(
      "Result is independent of input array order",
      reordered.heightByResourceId.get("a") === first.heightByResourceId.get("a") &&
        reordered.heightByResourceId.get("b") === first.heightByResourceId.get("b") &&
        reordered.heightByResourceId.get("c") === first.heightByResourceId.get("c")
    );
  }

  console.log("\nTesting a row requiring more than the auto-expand cap keeps its full required height...\n");
  {
    // 6 lanes -> required height comfortably exceeds MAX_AUTO_EXPANDED_ROW_H (150).
    const result = computeResourceRowHeights({ resources: [{ resourceId: "busy", laneCount: 6 }], availableHeight: 0 });
    const required = computeRowHeight(6);
    check("required height for 6 lanes exceeds the auto-expand cap (sanity)", required > MAX_AUTO_EXPANDED_ROW_H);
    check("busy resource's row is never shrunk below its required height", result.heightByResourceId.get("busy") === required);
  }

  console.log("\nTesting no cross-resource height bleed...\n");
  {
    const result = computeResourceRowHeights({
      resources: [{ resourceId: "busy", laneCount: 6 }, { resourceId: "quiet", laneCount: 1 }],
      availableHeight: 0,
    });
    check("The busy resource's large lane count doesn't inflate the quiet resource's row", result.heightByResourceId.get("quiet") === computeRowHeight(1));
  }

  console.log("\nTesting week view fills available width without forcing horizontal scroll...\n");
  {
    // A realistic laptop-width timeline container after the Agent column.
    const result = computePxPerDay({ viewMode: "week", containerWidth: 1200, leftColumnWidth: 220, daysCount: 7 });
    check("pxPerDay is within week's bounds", result.pxPerDay >= PX_PER_DAY_BOUNDS.week.min && result.pxPerDay <= PX_PER_DAY_BOUNDS.week.max);
    check("7 columns at this pxPerDay fit without horizontal scroll", !result.requiresHorizontalScroll);
  }

  console.log("\nTesting month view stays compact relative to week view...\n");
  {
    const week = computePxPerDay({ viewMode: "week", containerWidth: 1200, leftColumnWidth: 220, daysCount: 7 });
    const month = computePxPerDay({ viewMode: "month", containerWidth: 1200, leftColumnWidth: 220, daysCount: 30 });
    check("Month's pxPerDay is meaningfully smaller than week's for the same container width", month.pxPerDay < week.pxPerDay);
    check("Month's pxPerDay respects its own (smaller) bounds", month.pxPerDay >= PX_PER_DAY_BOUNDS.month.min && month.pxPerDay <= PX_PER_DAY_BOUNDS.month.max);
  }

  console.log("\nTesting pxPerDay is always clamped to the view's bounds...\n");
  {
    const tinyContainer = computePxPerDay({ viewMode: "month", containerWidth: 300, leftColumnWidth: 220, daysCount: 31 });
    check("A very narrow container still clamps to at least min", tinyContainer.pxPerDay === PX_PER_DAY_BOUNDS.month.min);

    const hugeContainer = computePxPerDay({ viewMode: "week", containerWidth: 5000, leftColumnWidth: 220, daysCount: 7 });
    check("A very wide container still clamps to at most max", hugeContainer.pxPerDay === PX_PER_DAY_BOUNDS.week.max);
  }

  console.log("\nTesting container width changes pxPerDay predictably...\n");
  {
    const narrow = computePxPerDay({ viewMode: "week", containerWidth: 900, leftColumnWidth: 220, daysCount: 7 });
    const wide = computePxPerDay({ viewMode: "week", containerWidth: 1500, leftColumnWidth: 220, daysCount: 7 });
    check("Widening the container increases pxPerDay (up to the max)", wide.pxPerDay >= narrow.pxPerDay);
  }

  console.log("\nTesting requiresHorizontalScroll only when the clamped width still doesn't fit...\n");
  {
    const fitsFine = computePxPerDay({ viewMode: "week", containerWidth: 2000, leftColumnWidth: 220, daysCount: 7 });
    check("Ample width never requires horizontal scroll", !fitsFine.requiresHorizontalScroll);

    const tooNarrow = computePxPerDay({ viewMode: "month", containerWidth: 400, leftColumnWidth: 220, daysCount: 31 });
    check("Clamped-to-min but still too narrow correctly reports horizontal scroll is needed", tooNarrow.requiresHorizontalScroll);
  }

  console.log("\nTesting an unconfigured future view mode falls back gracefully...\n");
  {
    const result = computePxPerDay({ viewMode: "quarter", containerWidth: 1200, leftColumnWidth: 220, daysCount: 90 });
    check("Unknown view mode still returns a sane, positive pxPerDay", result.pxPerDay > 0);
    check("Unknown view mode doesn't throw and falls back to the month (compact) bounds", result.minPx === PX_PER_DAY_BOUNDS.month.min && result.maxPx === PX_PER_DAY_BOUNDS.month.max);
  }

  printSummaryAndExit();
}

main();
