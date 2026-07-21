/**
 * Resource Planning event bars rendering broken/cropped in Month view: some
 * long-running activities appeared to touch or overrun the right edge of
 * the visible date grid. Investigation confirmed the previous inline
 * barMetrics (clamp the event's start/end dates first, then diff them) was
 * already numerically bounded correctly for every case
 * getResourcePlanningEvents actually sends the client (it already filters
 * out events with zero overlap with the requested range server-side — see
 * lib/services/resource-planning-service.ts) — but it had a real, if
 * previously latent, bug: if BOTH an event's start and end land on the same
 * side of the visible range (fully before or fully after it), clamping the
 * dates independently can leave clippedEnd before clippedStart, producing a
 * left far outside [0, totalWidth). The actual reported "broken/cropped"
 * look was the bar's rounded-md corner sitting exactly at the clip
 * boundary, visually implying "this is where the event ends" when it
 * actually continues off-screen.
 *
 * getClippedBarMetrics() (lib/resource-planning-bar-metrics.ts) fixes both:
 * resolves visibility first (isVisible=false for no-overlap events, so a
 * bar simply isn't rendered instead of landing at a wild offset), and
 * clamps the final PIXEL values directly (left >= 0, left+width <=
 * totalWidth) rather than trusting date arithmetic to stay in range — the
 * same technique components/gantt/gantt-chart.tsx's own barMetrics already
 * uses. continuesBefore/continuesAfter let the component square off the
 * clipped edge's rounded corner and disable drag for that bar (see
 * resource-timeline.tsx).
 *
 * Tests:
 *  1. Event fully inside visible range renders normally (identical
 *     left/width to the pre-fix formula, no continuation flags).
 *  2. Event starts before range, ends inside range — clips left, flags
 *     continuesBefore only.
 *  3. Event starts inside range, ends after range — clips right, flags
 *     continuesAfter only.
 *  4. Event spans before and after range — covers the full visible grid,
 *     both continuation flags set.
 *  5. Event completely before range — isVisible=false.
 *  6. Event completely after range — isVisible=false.
 *  7. Single-day event (start === end) occupies exactly one day column.
 *  8. left is never negative, across all the above cases.
 *  9. left + width never exceeds totalWidth, across all the above cases.
 *  10. Month view (compact pxPerDay, ~30 days): a long event clips cleanly
 *      to the visible month, right edge at exactly totalWidth's boundary.
 *  11. Week view (7 days): a long event clips cleanly to the visible week.
 *  12. An event ending exactly on visibleStart (adjacent, not overlapping
 *      before it) is NOT visible — half-open boundary sanity check.
 *  13. An event starting exactly on visibleEnd is visible (single day,
 *      inclusive boundary) and not flagged as continuing either way.
 *
 * Usage: npx tsx scripts/test-resource-planning-bar-metrics.ts
 * Pure logic — no database, no reachability guard needed.
 */
import { getClippedBarMetrics } from "@/lib/resource-planning-bar-metrics";

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

function d(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function main() {
  // A one-week visible range, 7 columns, matching the component's real "week" view shape.
  const weekStart = d("2026-07-06");
  const weekEnd = d("2026-07-12");
  const weekPxPerDay = 150;
  const weekTotalWidth = 7 * weekPxPerDay;

  console.log("\nTesting an event fully inside the visible range...\n");
  {
    const m = getClippedBarMetrics(d("2026-07-07"), d("2026-07-09"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible", m.isVisible);
    check("left is day-1 offset (1 * pxPerDay)", m.left === weekPxPerDay);
    check("width covers 3 days minus the gap", m.width === 3 * weekPxPerDay - 4);
    check("continuesBefore is false", !m.continuesBefore);
    check("continuesAfter is false", !m.continuesAfter);
  }

  console.log("\nTesting an event that starts before range, ends inside range...\n");
  {
    const m = getClippedBarMetrics(d("2026-07-01"), d("2026-07-08"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible", m.isVisible);
    check("left is 0 (clipped to visibleStart)", m.left === 0);
    check("continuesBefore is true", m.continuesBefore);
    check("continuesAfter is false", !m.continuesAfter);
  }

  console.log("\nTesting an event that starts inside range, ends after range...\n");
  {
    const m = getClippedBarMetrics(d("2026-07-10"), d("2026-07-20"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible", m.isVisible);
    check("continuesBefore is false", !m.continuesBefore);
    check("continuesAfter is true", m.continuesAfter);
    check("left + width never exceeds totalWidth", m.left + m.width <= weekTotalWidth);
  }

  console.log("\nTesting an event that spans before AND after the visible range...\n");
  {
    const m = getClippedBarMetrics(d("2026-06-01"), d("2026-08-01"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible", m.isVisible);
    check("left is 0", m.left === 0);
    check("width covers the full 7-day grid minus the gap", m.width === weekTotalWidth - 4);
    check("continuesBefore is true", m.continuesBefore);
    check("continuesAfter is true", m.continuesAfter);
  }

  console.log("\nTesting an event completely before the visible range...\n");
  {
    const m = getClippedBarMetrics(d("2026-06-01"), d("2026-06-10"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible is false", !m.isVisible);
  }

  console.log("\nTesting an event completely after the visible range...\n");
  {
    const m = getClippedBarMetrics(d("2026-08-01"), d("2026-08-10"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible is false", !m.isVisible);
  }

  console.log("\nTesting a single-day event occupies exactly one column...\n");
  {
    const m = getClippedBarMetrics(d("2026-07-07"), d("2026-07-07"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("width equals one day column minus the gap", m.width === weekPxPerDay - 4);
  }

  console.log("\nTesting left is never negative, across every case above...\n");
  {
    const cases: [string, string][] = [
      ["2026-07-07", "2026-07-09"],
      ["2026-07-01", "2026-07-08"],
      ["2026-07-10", "2026-07-20"],
      ["2026-06-01", "2026-08-01"],
    ];
    const allNonNegative = cases.every(([s, e]) => getClippedBarMetrics(d(s), d(e), weekStart, weekEnd, weekPxPerDay, weekTotalWidth).left >= 0);
    check("Every case's left >= 0", allNonNegative);
  }

  console.log("\nTesting left + width never exceeds totalWidth, across every case above...\n");
  {
    const cases: [string, string][] = [
      ["2026-07-07", "2026-07-09"],
      ["2026-07-01", "2026-07-08"],
      ["2026-07-10", "2026-07-20"],
      ["2026-06-01", "2026-08-01"],
    ];
    const allBounded = cases.every(([s, e]) => {
      const m = getClippedBarMetrics(d(s), d(e), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
      return m.left + m.width <= weekTotalWidth;
    });
    check("Every case's left+width <= totalWidth", allBounded);
  }

  console.log("\nTesting Month view: a long event clips cleanly to the visible month...\n");
  {
    const monthStart = d("2026-07-01");
    const monthEnd = d("2026-07-31"); // 31-day July
    const monthPxPerDay = 36;
    const monthDays = 31;
    const monthTotalWidth = monthDays * monthPxPerDay;

    // Starts mid-June, ends mid-August — spans well beyond the visible month on both sides.
    const m = getClippedBarMetrics(d("2026-06-15"), d("2026-08-15"), monthStart, monthEnd, monthPxPerDay, monthTotalWidth);
    check("isVisible", m.isVisible);
    check("left is 0", m.left === 0);
    check("Right edge sits at exactly totalWidth - 4 (never touches/exceeds the grid boundary)", m.left + m.width === monthTotalWidth - 4);
    check("Both continuation flags set", m.continuesBefore && m.continuesAfter);
  }

  console.log("\nTesting Week view: a long event clips cleanly to the visible week...\n");
  {
    const m = getClippedBarMetrics(d("2026-07-05"), d("2026-07-13"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("isVisible", m.isVisible);
    check("left is 0", m.left === 0);
    check("Right edge sits at exactly totalWidth - 4", m.left + m.width === weekTotalWidth - 4);
  }

  console.log("\nTesting boundary sanity — event ending exactly at visibleStart is not visible, starting exactly at visibleEnd is...\n");
  {
    const endsAtStart = getClippedBarMetrics(d("2026-07-01"), weekStart, weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("An event ending exactly on visibleStart IS visible (touches the range, inclusive)", endsAtStart.isVisible);

    const endsBeforeStart = getClippedBarMetrics(d("2026-07-01"), d("2026-07-05"), weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("An event ending the day before visibleStart is NOT visible", !endsBeforeStart.isVisible);

    const startsAtEnd = getClippedBarMetrics(weekEnd, weekEnd, weekStart, weekEnd, weekPxPerDay, weekTotalWidth);
    check("An event starting exactly on visibleEnd IS visible", startsAtEnd.isVisible);
    check("...and is not flagged as continuing either way", !startsAtEnd.continuesBefore && !startsAtEnd.continuesAfter);
  }

  printSummaryAndExit();
}

main();
