/**
 * Pure unit coverage for the same-day-start warning rule
 * (lib/activities/activity-conflict.ts) — no DB, no auth, no server. This
 * function is intentionally DB-free so it can run identically server-side
 * (app/(main)/projects/[id]/page.tsx, initial render) and client-side
 * (components/projects/project-activity-sequence-card.tsx, recomputed on
 * every completion toggle) — this script exercises it directly.
 *
 * Usage: npx tsx scripts/test-activity-conflict.ts
 */
import { computeSameDayStartWarnings, type SameDayStartCandidate } from "@/lib/activities/activity-conflict";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function act(id: string, expectedStartDate: string | null, isCompleted: boolean): SameDayStartCandidate {
  return { id, expectedStartDate, isCompleted };
}

function main() {
  console.log("\n=== 1-2. Two active Activities, same day -> both warn ===\n");
  {
    const result = computeSameDayStartWarnings([act("A", "2026-10-10", false), act("B", "2026-10-10", false)]);
    check("1. A warns, with 1 other active conflicting Activity", result.get("A")!.hasSameDayStartWarning === true && result.get("A")!.sameDayStartActiveCount === 1);
    check("2. B warns too, symmetrically", result.get("B")!.hasSameDayStartWarning === true && result.get("B")!.sameDayStartActiveCount === 1);
  }

  console.log("\n=== 3. A becomes Completed -> neither A nor B warns (only one active remains) ===\n");
  {
    const result = computeSameDayStartWarnings([act("A", "2026-10-10", true), act("B", "2026-10-10", false)]);
    check("3a. Completed A never warns", result.get("A")!.hasSameDayStartWarning === false && result.get("A")!.sameDayStartActiveCount === 0);
    check("3b. B no longer warns either — no other ACTIVE conflicting Activity remains", result.get("B")!.hasSameDayStartWarning === false && result.get("B")!.sameDayStartActiveCount === 0);
  }

  console.log("\n=== 4. Three same-day Activities, one Completed -> the two active ones still warn, the completed one never does ===\n");
  {
    const result = computeSameDayStartWarnings([
      act("A", "2026-10-10", true),
      act("B", "2026-10-10", false),
      act("C", "2026-10-10", false),
    ]);
    check("4a. Completed A: no warning", result.get("A")!.hasSameDayStartWarning === false);
    check("4b. B warns, exactly 1 other active conflict (C)", result.get("B")!.hasSameDayStartWarning === true && result.get("B")!.sameDayStartActiveCount === 1);
    check("4c. C warns, exactly 1 other active conflict (B)", result.get("C")!.hasSameDayStartWarning === true && result.get("C")!.sameDayStartActiveCount === 1);
  }

  console.log("\n=== 5. Different dates -> no conflict ===\n");
  {
    const result = computeSameDayStartWarnings([act("A", "2026-10-10", false), act("B", "2026-10-11", false)]);
    check("5. Different expectedStart dates never conflict", !result.get("A")!.hasSameDayStartWarning && !result.get("B")!.hasSameDayStartWarning);
  }

  console.log("\n=== 6. Multiple same-day actives -> correct N-other count, correct tooltip plural threshold ===\n");
  {
    const result = computeSameDayStartWarnings([
      act("A", "2026-10-10", false),
      act("B", "2026-10-10", false),
      act("C", "2026-10-10", false),
      act("D", "2026-10-10", false),
    ]);
    check("6. Each of 4 same-day active Activities sees exactly 3 OTHER active conflicts, never counting itself", [...result.values()].every((w) => w.hasSameDayStartWarning && w.sameDayStartActiveCount === 3));
  }

  console.log("\n=== 7. No expectedStartDate -> never participates, never crashes ===\n");
  {
    const result = computeSameDayStartWarnings([act("A", null, false), act("B", "2026-10-10", false), act("C", null, false)]);
    check("7a. An Activity with no expectedStartDate never warns", !result.get("A")!.hasSameDayStartWarning && !result.get("C")!.hasSameDayStartWarning);
    check("7b. ...and never counts as a conflict for a dated sibling", !result.get("B")!.hasSameDayStartWarning && result.get("B")!.sameDayStartActiveCount === 0);
  }

  console.log("\n=== 8. A solitary active Activity (no siblings at all) never warns ===\n");
  {
    const result = computeSameDayStartWarnings([act("A", "2026-10-10", false)]);
    check("8. A lone active Activity on its own day never warns", !result.get("A")!.hasSameDayStartWarning && result.get("A")!.sameDayStartActiveCount === 0);
  }

  console.log("\n=== 9. Accepts Date objects (not just ISO strings), same as the DB-shaped value Prisma returns ===\n");
  {
    const result = computeSameDayStartWarnings([
      { id: "A", expectedStartDate: new Date("2026-10-10T08:00:00Z"), isCompleted: false },
      { id: "B", expectedStartDate: new Date("2026-10-10T23:00:00Z"), isCompleted: false },
    ]);
    check("9. Two Date objects on the SAME UTC calendar day (different times) still conflict", result.get("A")!.hasSameDayStartWarning && result.get("B")!.hasSameDayStartWarning);
  }

  console.log("\n=== 10. Reopening (un-completing) recalculates the warning back on ===\n");
  {
    const completedState = computeSameDayStartWarnings([act("A", "2026-10-10", true), act("B", "2026-10-10", false)]);
    check("10a. While A is completed, B has no warning", !completedState.get("B")!.hasSameDayStartWarning);
    const reopenedState = computeSameDayStartWarnings([act("A", "2026-10-10", false), act("B", "2026-10-10", false)]);
    check("10b. Reopening A (isCompleted: false again) brings the warning back for BOTH", reopenedState.get("A")!.hasSameDayStartWarning && reopenedState.get("B")!.hasSameDayStartWarning);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
