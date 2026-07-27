/**
 * Pure-function tests for lib/overdue.ts — the single central "overdue"
 * rule shared by every surface (Projects/Activities list+cards, Gantt,
 * Resource Planning, Projects Dashboard). No DB needed: these are the
 * timezone-safety/boundary/terminal-short-circuit guarantees the rule
 * itself must hold regardless of any particular row's data.
 *
 * Usage: npx tsx scripts/test-overdue-logic.ts
 */
import { isOverdue, endOfDueDateUtc, startOfTodayUtc } from "@/lib/overdue";

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

console.log("Testing isOverdue's core rule...\n");

check("No dueDate is never overdue, regardless of terminal-ness", !isOverdue(null, false, new Date("2026-07-23T12:00:00.000Z")));
check("A terminal item with a far-past dueDate is NOT overdue", !isOverdue(new Date("2020-01-01T00:00:00.000Z"), true, new Date("2026-07-23T12:00:00.000Z")));
check("A non-terminal item with a far-past dueDate IS overdue", isOverdue(new Date("2020-01-01T00:00:00.000Z"), false, new Date("2026-07-23T12:00:00.000Z")));

console.log("\nTesting the exact due-date-day boundary (timezone-safety)...\n");

// dueDate = 2026-07-20 (stored as UTC midnight, as Prisma does for a
// date-only value). The day is not "used up" until the FULL day has
// elapsed, i.e. overdue starts at 2026-07-21T00:00:00.000Z, never earlier.
const dueDate = new Date("2026-07-20T00:00:00.000Z");
check("At the exact start of the due date's day — NOT yet overdue", !isOverdue(dueDate, false, new Date("2026-07-20T00:00:00.000Z")));
check("At noon ON the due date's own day — still NOT overdue", !isOverdue(dueDate, false, new Date("2026-07-20T12:00:00.000Z")));
check("At 23:59:59.999 on the due date's own day — still NOT overdue", !isOverdue(dueDate, false, new Date("2026-07-20T23:59:59.999Z")));
check("Exactly at the start of the NEXT day — now overdue", isOverdue(dueDate, false, new Date("2026-07-21T00:00:00.000Z")));
check("One millisecond into the next day — overdue", isOverdue(dueDate, false, new Date("2026-07-21T00:00:00.001Z")));
check("Several days later — still overdue", isOverdue(dueDate, false, new Date("2026-07-25T00:00:00.000Z")));

console.log("\nTesting endOfDueDateUtc computes the correct next-UTC-midnight regardless of a mid-day dueDate instant...\n");
const midDayDue = new Date("2026-07-20T15:30:00.000Z");
check(
  "A dueDate stored mid-day still rolls over at the NEXT day's UTC midnight (the calendar day, not +24h from the instant)",
  endOfDueDateUtc(midDayDue).toISOString() === "2026-07-21T00:00:00.000Z"
);

console.log("\nTesting startOfTodayUtc's SQL-prefilter equivalence to isOverdue's boundary...\n");
const now = new Date("2026-07-23T09:15:00.000Z");
const todayStart = startOfTodayUtc(now);
check("startOfTodayUtc returns today's UTC midnight", todayStart.toISOString() === "2026-07-23T00:00:00.000Z");

// dueDate < startOfTodayUtc(now) must agree with isOverdue(dueDate, false, now) for every case around the boundary.
const casesAroundBoundary: Date[] = [
  new Date("2026-07-21T00:00:00.000Z"), // 2 days before today -> overdue
  new Date("2026-07-22T00:00:00.000Z"), // yesterday -> overdue
  new Date("2026-07-22T23:59:59.999Z"), // yesterday, end of day -> overdue
  new Date("2026-07-23T00:00:00.000Z"), // today -> not yet overdue
  new Date("2026-07-23T09:00:00.000Z"), // today, before `now` -> not yet overdue
  new Date("2026-07-24T00:00:00.000Z"), // tomorrow -> not overdue
];
for (const d of casesAroundBoundary) {
  const sqlPrefilterSaysOverdueEligible = d.getTime() < todayStart.getTime();
  const isOverdueSays = isOverdue(d, false, now);
  check(
    `SQL prefilter (dueDate < startOfTodayUtc) agrees with isOverdue for dueDate=${d.toISOString()}`,
    sqlPrefilterSaysOverdueEligible === isOverdueSays
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
