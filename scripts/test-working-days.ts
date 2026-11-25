/**
 * Unit coverage for the canonical working-day calculation
 * (lib/date-only.ts): Mon–Fri count, Sat/Sun excluded, half-open
 * [start, finish) boundary (same-day = 0), UTC date-only arithmetic.
 *
 * Every specific case is ALSO checked against an independent, naive
 * day-by-day reference, plus a randomized sweep, so the O(1) implementation
 * can't silently drift from the rule.
 *
 * Usage: npx tsx scripts/test-working-days.ts
 */
import { workingDaysBetween, calculateWorkingDays, actualDaysFromCompletion, isSameDateOnly } from "@/lib/date-only";
import { calculateProjectDurationDays } from "@/lib/project-duration";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

/** Independent reference: walk each UTC day in [start, finish) and count Mon–Fri. */
function naive(startIso: string, finishIso: string): number {
  const s = new Date(startIso.slice(0, 10) + "T00:00:00Z");
  const f = new Date(finishIso.slice(0, 10) + "T00:00:00Z");
  const sign = f >= s ? 1 : -1;
  let [a, b] = sign === 1 ? [s, f] : [f, s];
  let n = 0;
  for (let d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return sign * n;
}
const D = (iso: string) => new Date(iso);

const CASES: [string, string, string, number][] = [
  // label, start, finish, expected
  ["same day (weekday) = 0", "2026-10-07", "2026-10-07", 0],
  ["same day (Saturday) = 0", "2026-10-10", "2026-10-10", 0],
  ["Mon -> Fri, no weekend = 4", "2026-10-05", "2026-10-09", 4],
  ["Mon -> next Mon (spans one weekend) = 5", "2026-10-05", "2026-10-12", 5],
  ["Fri -> Mon (weekend in between) = 1", "2026-10-09", "2026-10-12", 1],
  ["Thu -> Mon = 2", "2026-10-01", "2026-10-05", 2],
  ["Mon -> Mon three weeks later (multiple weekends) = 15", "2026-10-05", "2026-10-26", 15],
  ["Sat -> Sun (weekend only) = 0", "2026-10-10", "2026-10-11", 0],
  ["Sat -> Mon (weekend only before finish) = 0", "2026-10-10", "2026-10-12", 0],
  ["Fri -> Sat = 1", "2026-10-09", "2026-10-10", 1],
  ["Sun -> Tue = 1", "2026-10-11", "2026-10-13", 1],
  ["month boundary Fri 2026-10-30 -> Tue 2026-11-03 = 2", "2026-10-30", "2026-11-03", 2],
  ["year boundary Wed 2026-12-30 -> Mon 2027-01-04 = 3", "2026-12-30", "2027-01-04", 3],
  ["leap day: Mon 2028-02-28 -> Thu 2028-03-02 = 3", "2028-02-28", "2028-03-02", 3],
  ["whole leap year 2028 = 260", "2028-01-01", "2029-01-01", 260],
  ["whole year 2027 = 261", "2027-01-01", "2028-01-01", 261],
  ["EU DST start (Sun 2026-03-29) Fri 03-27 -> Tue 03-31 = 2", "2026-03-27", "2026-03-31", 2],
  ["EU DST end (Sun 2026-10-25) Fri 10-23 -> Tue 10-27 = 2", "2026-10-23", "2026-10-27", 2],
  ["Quarter Q2 2027 (2027-04-01 -> 2027-06-30) = 64", "2027-04-01", "2027-06-30", 64],
  ["Quarter Q4 2026 -> Q1 2027 (2026-10-01 -> 2027-03-31) = 129", "2026-10-01", "2027-03-31", 129],
];

console.log("\n=== Specific cases (each also verified against the naive reference) ===\n");
for (const [label, s, f, expected] of CASES) {
  const got = workingDaysBetween(D(s), D(f));
  check(`${label}`, got === expected && got === naive(s, f), `got ${got}, naive ${naive(s, f)}`);
}

console.log("\n=== Time-of-day / timezone independence (UTC date-only) ===\n");
check("non-midnight times use the UTC calendar date (Mon 23:59Z -> Wed 00:01Z = 2)", workingDaysBetween(D("2026-10-05T23:59:00Z"), D("2026-10-07T00:01:00Z")) === 2);
check("offset strings normalise to UTC (2026-10-05T01:00+03:00 is Sun 22:00Z) -> Wed = 2", workingDaysBetween(D("2026-10-05T01:00:00+03:00"), D("2026-10-07T00:00:00Z")) === 2);
check("YYYY-MM-DD strings (form inputs) parse as UTC midnight", calculateWorkingDays("2026-10-05", "2026-10-09") === 4);

console.log("\n=== Null / invalid / reversed handling preserved ===\n");
check("reversed range is the negated count (callers reject/clamp/null as before)", workingDaysBetween(D("2026-10-09"), D("2026-10-05")) === -4);
check("calculateWorkingDays: reversed -> null", calculateWorkingDays("2026-10-09", "2026-10-05") === null);
check("calculateWorkingDays: missing start / finish -> null", calculateWorkingDays(null, "2026-10-05") === null && calculateWorkingDays("2026-10-05", undefined) === null && calculateWorkingDays("", "2026-10-05") === null);
check("calculateWorkingDays: invalid date -> null", calculateWorkingDays("not-a-date", "2026-10-05") === null);
check("weekend-only via calculateWorkingDays -> 0 (not null)", calculateWorkingDays("2026-10-10", "2026-10-11") === 0);
check("Project resolver uses the same calculation", calculateProjectDurationDays("2026-10-05", "2026-10-12") === 5);
check("actualDaysFromCompletion: working days, clamped at 0 for early completion", actualDaysFromCompletion(D("2026-10-05"), D("2026-10-12T15:00:00Z")) === 5 && actualDaysFromCompletion(D("2026-10-12"), D("2026-10-05")) === 0);

console.log("\n=== isSameDateOnly ===\n");
check("same UTC date, different times -> true", isSameDateOnly(D("2026-10-05T00:00:00Z"), D("2026-10-05T18:00:00Z")));
check("different dates -> false; null/null -> true; date/null -> false", !isSameDateOnly(D("2026-10-05"), D("2026-10-06")) && isSameDateOnly(null, undefined) && !isSameDateOnly(D("2026-10-05"), null));

console.log("\n=== Randomized sweep vs naive reference (5,000 ranges, 1990–2060) ===\n");
let mismatches = 0;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const base = Date.UTC(1990, 0, 1);
for (let i = 0; i < 5000; i++) {
  const a = new Date(base + Math.floor(rnd() * 25500) * 86400000).toISOString().slice(0, 10);
  const b = new Date(base + Math.floor(rnd() * 25500) * 86400000).toISOString().slice(0, 10);
  if (workingDaysBetween(D(a), D(b)) !== naive(a, b)) mismatches++;
}
check("0 mismatches across 5,000 random ranges (incl. reversed)", mismatches === 0, String(mismatches));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
