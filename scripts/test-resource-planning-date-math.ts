/**
 * Pure-function tests for the timeline drag date arithmetic:
 * lib/resource-planning-date-math.ts (Resource Planning) and the canonical
 * mechanism it delegates to, lib/date-only.ts's shiftDateOnly (also used by
 * Project Gantt). No DOM, no DB, no dev server: run directly with `npx tsx`.
 *
 * Convention under test (lib/date-only.ts): date-only values are stored at
 * UTC midnight and read by their UTC calendar date. A shift moves that UTC
 * calendar date by N days and serializes back to exact UTC midnight — so
 * the result must be IDENTICAL in every runtime time zone and across DST.
 * The whole suite therefore runs once per time zone (UTC, Europe/Athens,
 * America/New_York — Node honours process.env.TZ changes at runtime), with
 * the original cross-month/year, month-length, leap-year, DST and
 * negative-delta cases from the cross-month drag bug report.
 */
import { shiftActivityDate, calendarDurationDays } from "@/lib/resource-planning-date-math";
import { shiftDateOnly, toDateOnlyIso, workingDaysBetween } from "@/lib/date-only";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; }
}
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString();
const ymd = (iso: string) => iso.slice(0, 10);
const isUtcMidnight = (iso: string) => iso.endsWith("T00:00:00.000Z");

function checkShift(label: string, fromY: number, fromM: number, fromD: number, days: number, expectY: number, expectM: number, expectD: number) {
  const shifted = shiftActivityDate(utc(fromY, fromM, fromD), days);
  const expected = utc(expectY, expectM, expectD);
  check(`${label}: ${ymd(utc(fromY, fromM, fromD))} ${days >= 0 ? "+" : ""}${days}d => ${ymd(shifted)} (expected ${ymd(expected)}), exact UTC midnight`, shifted === expected && isUtcMidnight(shifted));
}

const ZONES = ["UTC", "Europe/Athens", "America/New_York"];
const results = new Map<string, string[]>();

for (const tz of ZONES) {
  process.env.TZ = tz;
  console.log(`\n================ TZ=${tz} (offset now ${-new Date().getTimezoneOffset() / 60}h) ================`);
  const outputs: string[] = [];

  console.log("\n--- Exact cases from the bug report: 28/07 -> 05/08 ---\n");
  checkShift("28/07 +1d", 2026, 7, 28, 1, 2026, 7, 29);
  checkShift("28/07 +3d", 2026, 7, 28, 3, 2026, 7, 31);
  checkShift("28/07 +10d", 2026, 7, 28, 10, 2026, 8, 7);
  checkShift("05/08 -30d", 2026, 8, 5, -30, 2026, 7, 6);
  {
    const start = utc(2026, 7, 28), end = utc(2026, 8, 5);
    check("28/07 -> 05/08 duration is exactly 8 calendar days", calendarDurationDays(start, end) === 8);
    const s3 = shiftActivityDate(start, 3), e3 = shiftActivityDate(end, 3);
    check("Duration preserved after +3d shift (both endpoints)", calendarDurationDays(s3, e3) === 8);
    check("+3d: start 31/07, due 08/08", ymd(s3) === "2026-07-31" && ymd(e3) === "2026-08-08");
    outputs.push(s3, e3);
  }

  console.log("\n--- Year boundary ---\n");
  checkShift("28/12 +8d (into next year)", 2026, 12, 28, 8, 2027, 1, 5);
  checkShift("30/12 +2d", 2026, 12, 30, 2, 2027, 1, 1);

  console.log("\n--- Every month-length boundary (28/29/30/31 days) ---\n");
  checkShift("31/01 +1d", 2026, 1, 31, 1, 2026, 2, 1);
  checkShift("30/04 +1d", 2026, 4, 30, 1, 2026, 5, 1);
  checkShift("31/03 +1d", 2026, 3, 31, 1, 2026, 4, 1);
  checkShift("30/06 +1d", 2026, 6, 30, 1, 2026, 7, 1);

  console.log("\n--- February / leap year ---\n");
  checkShift("28/02/2028 (leap) +1d => 29/02", 2028, 2, 28, 1, 2028, 2, 29);
  checkShift("29/02/2028 (leap) +1d => 01/03", 2028, 2, 29, 1, 2028, 3, 1);
  checkShift("28/02/2026 (non-leap) +1d => 01/03", 2026, 2, 28, 1, 2026, 3, 1);
  checkShift("28/02/2000 (leap, /400 rule) +1d => 29/02", 2000, 2, 28, 1, 2000, 2, 29);
  checkShift("28/02/1900 (NOT leap) +1d => 01/03", 1900, 2, 28, 1, 1900, 3, 1);

  console.log("\n--- DST transitions (Athens: last Sun of Mar/Oct; New York: 2nd Sun of Mar / 1st Sun of Nov) ---\n");
  checkShift("Athens 27/03/2026 +3d (crosses 2026-03-29 spring-forward)", 2026, 3, 27, 3, 2026, 3, 30);
  checkShift("Athens 23/10/2026 +3d (crosses 2026-10-25 fall-back)", 2026, 10, 23, 3, 2026, 10, 26);
  checkShift("Athens 24/10/2026 +1d (into fall-back day)", 2026, 10, 24, 1, 2026, 10, 25);
  checkShift("Athens 28/03/2026 +1d (into spring-forward day)", 2026, 3, 28, 1, 2026, 3, 29);
  checkShift("Athens 26/03/2027 +2d (into 2027-03-28 spring-forward)", 2027, 3, 26, 2, 2027, 3, 28);
  checkShift("New York 13/03/2027 +1d (into 2027-03-14 spring-forward)", 2027, 3, 13, 1, 2027, 3, 14);
  checkShift("New York 31/10/2026 +2d (crosses 2026-11-01 fall-back)", 2026, 10, 31, 2, 2026, 11, 2);
  checkShift("New York 02/11/2026 -2d (back across fall-back)", 2026, 11, 2, -2, 2026, 10, 31);
  {
    const s = utc(2027, 3, 26), e = utc(2027, 3, 30);
    const s2 = shiftActivityDate(s, 1), e2 = shiftActivityDate(e, 1);
    check("Range across the Athens spring-forward keeps duration (4 calendar days) and working days", calendarDurationDays(s2, e2) === 4 && workingDaysBetween(new Date(s2), new Date(e2)) === workingDaysBetween(new Date(utc(2027, 3, 27)), new Date(utc(2027, 3, 31))));
    outputs.push(s2, e2);
  }

  console.log("\n--- Negative deltas across boundaries ---\n");
  checkShift("05/01/2027 -8d (back across year boundary)", 2027, 1, 5, -8, 2026, 12, 28);
  checkShift("01/03/2026 -1d (back into Feb, non-leap)", 2026, 3, 1, -1, 2026, 2, 28);
  checkShift("01/03/2028 -1d (back into Feb, leap)", 2028, 3, 1, -1, 2028, 2, 29);

  console.log("\n--- Zero delta, legacy time-of-day values, Gantt parity ---\n");
  check("+0d leaves a canonical value unchanged", shiftActivityDate(utc(2026, 7, 28), 0) === utc(2026, 7, 28));
  check("Legacy 02:00Z / 03:00Z values keep their UTC calendar date, normalized to midnight", shiftActivityDate("2027-01-07T02:00:00.000Z", 1) === utc(2027, 1, 8) && shiftActivityDate("2027-01-07T03:00:00.000Z", 0) === utc(2027, 1, 7) && toDateOnlyIso("2027-01-07T03:00:00.000Z") === utc(2027, 1, 7));
  check("Resource Planning shift === Project Gantt shift (shared shiftDateOnly) for the same move", shiftActivityDate(utc(2027, 3, 26), 5) === shiftDateOnly(utc(2027, 3, 26), 5));
  outputs.push(shiftActivityDate("2027-01-07T02:00:00.000Z", 1));
  results.set(tz, outputs);
}

console.log("\n--- Identical results in every time zone ---\n");
const [first, ...rest] = ZONES.map((z) => JSON.stringify(results.get(z)));
check(`Same serialized values under ${ZONES.join(", ")}`, rest.every((r) => r === first));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
