/**
 * lib/activity-priority.ts — the canonical "most urgent first" ranking
 * introduced for the Resource Planning timeline (one-lane-per-activity,
 * ordered URGENT..LOW) and its server-side default sort. This is the
 * single shared source of truth both are required to use rather than each
 * re-deriving their own priority order locally.
 *
 * Tests:
 *  1. URGENT ranks above HIGH, HIGH above MEDIUM, MEDIUM above LOW.
 *  2. comparePriorityDesc sorts a shuffled array into URGENT, HIGH, MEDIUM, LOW.
 *  3. Missing/null/unknown priority values rank below LOW (sort last).
 *  4. Equal priorities compare as 0 (no forced ordering between them —
 *     callers apply their own secondary sort key).
 *  5. ACTIVITY_PRIORITY_LABEL has a human label for all 4 real enum values.
 *
 * Usage: npx tsx scripts/test-activity-priority-order.ts
 * Pure logic — no database, no reachability guard needed.
 */
import { ActivityPriority } from "@prisma/client";
import { activityPriorityRank, comparePriorityDesc, ACTIVITY_PRIORITY_LABEL } from "@/lib/activity-priority";

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
  console.log("\nTesting the canonical rank ordering...\n");
  check("URGENT ranks above HIGH", activityPriorityRank("URGENT") > activityPriorityRank("HIGH"));
  check("HIGH ranks above MEDIUM", activityPriorityRank("HIGH") > activityPriorityRank("MEDIUM"));
  check("MEDIUM ranks above LOW", activityPriorityRank("MEDIUM") > activityPriorityRank("LOW"));

  console.log("\nTesting comparePriorityDesc sorts a shuffled list correctly...\n");
  {
    const shuffled = ["LOW", "URGENT", "MEDIUM", "LOW", "HIGH", "URGENT"];
    const sorted = [...shuffled].sort(comparePriorityDesc);
    check("Sorted result is URGENT, URGENT, HIGH, MEDIUM, LOW, LOW", sorted.join(",") === "URGENT,URGENT,HIGH,MEDIUM,LOW,LOW");
  }

  console.log("\nTesting missing/unknown priority ranks last...\n");
  check("null ranks below LOW", activityPriorityRank(null) < activityPriorityRank("LOW"));
  check("undefined ranks below LOW", activityPriorityRank(undefined) < activityPriorityRank("LOW"));
  check("empty string ranks below LOW", activityPriorityRank("") < activityPriorityRank("LOW"));
  check("an unrecognized string ranks below LOW, doesn't throw", activityPriorityRank("NOT_A_REAL_PRIORITY") < activityPriorityRank("LOW"));

  console.log("\nTesting equal priorities compare as 0...\n");
  check("comparePriorityDesc(HIGH, HIGH) === 0", comparePriorityDesc("HIGH", "HIGH") === 0);
  check("comparePriorityDesc(null, null) === 0 (both unknown)", comparePriorityDesc(null, null) === 0);

  console.log("\nTesting every real ActivityPriority enum value has a label...\n");
  const allLabeled = (Object.values(ActivityPriority) as ActivityPriority[]).every(
    (p) => typeof ACTIVITY_PRIORITY_LABEL[p] === "string" && ACTIVITY_PRIORITY_LABEL[p].length > 0
  );
  check("All 4 enum values (LOW/MEDIUM/HIGH/URGENT) have a non-empty label", allLabeled);

  printSummaryAndExit();
}

main();
