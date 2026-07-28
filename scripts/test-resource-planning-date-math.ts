/**
 * Pure-function tests for lib/resource-planning-date-math.ts — the
 * cross-month/cross-year/leap-year/DST drag date arithmetic. No DOM, no
 * DB, no dev server: run directly with `npx tsx`.
 *
 * These are the exact cases from the cross-month drag bug report: an
 * activity spanning 28/07 -> 05/08 must shift correctly regardless of which
 * calendar boundary the delta crosses. Every case constructs dates via
 * `new Date(y, m-1, d)` (LOCAL midnight, exactly how the app's own data is
 * created) so this exercises the real local-timezone behavior of the
 * runtime it executes in, not an idealized UTC-only scenario.
 */
import { shiftActivityDate, calendarDurationDays } from "@/lib/resource-planning-date-math";

let passed = 0;
let failed = 0;

function localMidnightISO(y: number, m: number, d: number): string {
  const dt = new Date();
  dt.setFullYear(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt.toISOString();
}

/** Reads back a shifted ISO string as {y,m,d} in LOCAL time — matches how the UI actually displays it. */
function localYMD(iso: string): { y: number; m: number; d: number } {
  const dt = new Date(iso);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function checkShift(label: string, fromY: number, fromM: number, fromD: number, days: number, expectY: number, expectM: number, expectD: number) {
  const shifted = shiftActivityDate(localMidnightISO(fromY, fromM, fromD), days);
  const got = localYMD(shifted);
  check(
    `${label}: ${fromD}/${fromM}/${fromY} +${days}d => ${got.d}/${got.m}/${got.y} (expected ${expectD}/${expectM}/${expectY})`,
    got.y === expectY && got.m === expectM && got.d === expectD
  );
  // Also confirm the result is exact local midnight — no off-by-one time drift.
  const dt = new Date(shifted);
  check(`${label}: shifted result is exact local midnight (no time-of-day drift)`, dt.getHours() === 0 && dt.getMinutes() === 0 && dt.getSeconds() === 0);
}

console.log("\n--- Exact cases from the bug report: 28/07 -> 05/08 ---\n");
checkShift("28/07 +1d", 2026, 7, 28, 1, 2026, 7, 29);
checkShift("28/07 +3d", 2026, 7, 28, 3, 2026, 7, 31);
checkShift("28/07 +10d", 2026, 7, 28, 10, 2026, 8, 7);
checkShift("05/08 -30d", 2026, 8, 5, -30, 2026, 7, 6);
{
  const start = localMidnightISO(2026, 7, 28);
  const end = localMidnightISO(2026, 8, 5);
  check("28/07 -> 05/08 duration is exactly 8 calendar days", calendarDurationDays(start, end) === 8);
  const shiftedStart = shiftActivityDate(start, 3);
  const shiftedEnd = shiftActivityDate(end, 3);
  check("Duration preserved after +3d shift (both endpoints)", calendarDurationDays(shiftedStart, shiftedEnd) === 8);
  const gotStart = localYMD(shiftedStart);
  const gotEnd = localYMD(shiftedEnd);
  check("+3d: startDate becomes 31/07", gotStart.d === 31 && gotStart.m === 7 && gotStart.y === 2026);
  check("+3d: dueDate becomes 08/08", gotEnd.d === 8 && gotEnd.m === 8 && gotEnd.y === 2026);
}

console.log("\n--- Year boundary ---\n");
checkShift("28/12 +8d (into next year)", 2026, 12, 28, 8, 2027, 1, 5);
checkShift("30/12 +2d", 2026, 12, 30, 2, 2027, 1, 1);

console.log("\n--- Every month-length boundary (28/29/30/31 days) ---\n");
checkShift("31/01 +1d (Jan has 31 days)", 2026, 1, 31, 1, 2026, 2, 1);
checkShift("30/04 +1d (Apr has 30 days)", 2026, 4, 30, 1, 2026, 5, 1);
checkShift("31/03 +1d (Mar has 31 days)", 2026, 3, 31, 1, 2026, 4, 1);
checkShift("30/06 +1d (Jun has 30 days)", 2026, 6, 30, 1, 2026, 7, 1);

console.log("\n--- February / leap year ---\n");
checkShift("28/02/2028 (leap) +1d => 29/02", 2028, 2, 28, 1, 2028, 2, 29);
checkShift("29/02/2028 (leap) +1d => 01/03", 2028, 2, 29, 1, 2028, 3, 1);
checkShift("28/02/2026 (non-leap) +1d => 01/03", 2026, 2, 28, 1, 2026, 3, 1);
checkShift("28/02/2000 (leap, /400 rule) +1d => 29/02", 2000, 2, 28, 1, 2000, 2, 29);
checkShift("28/02/1900 (NOT leap, /100 but not /400) +1d => 01/03", 1900, 2, 28, 1, 1900, 3, 1);

console.log("\n--- DST boundaries (Greece: spring-forward last Sunday of March, fall-back last Sunday of October) ---\n");
checkShift("27/03/2026 +3d (crosses 2026-03-29 spring-forward)", 2026, 3, 27, 3, 2026, 3, 30);
checkShift("23/10/2026 +3d (crosses 2026-10-25 fall-back)", 2026, 10, 23, 3, 2026, 10, 26);
checkShift("24/10/2026 +1d (day of fall-back itself)", 2026, 10, 24, 1, 2026, 10, 25);
checkShift("28/03/2026 +1d (day before spring-forward, into it)", 2026, 3, 28, 1, 2026, 3, 29);

console.log("\n--- Negative deltas across boundaries ---\n");
checkShift("05/01/2027 -8d (back across year boundary)", 2027, 1, 5, -8, 2026, 12, 28);
checkShift("01/03/2026 -1d (back into Feb, non-leap)", 2026, 3, 1, -1, 2026, 2, 28);
checkShift("01/03/2028 -1d (back into Feb, leap)", 2028, 3, 1, -1, 2028, 2, 29);

console.log("\n--- Zero delta is a true no-op ---\n");
{
  const iso = localMidnightISO(2026, 7, 28);
  const shifted = shiftActivityDate(iso, 0);
  const got = localYMD(shifted);
  check("+0d leaves the date unchanged", got.y === 2026 && got.m === 7 && got.d === 28);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
