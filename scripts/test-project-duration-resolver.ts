/**
 * Pure unit coverage for lib/project-duration.ts (the ONE canonical Project
 * duration resolver) and the client-side override parser. No DB.
 *
 * Usage: npx tsx scripts/test-project-duration-resolver.ts
 */
import { calculateProjectDurationDays, resolveProjectDuration } from "@/lib/project-duration";
import { parseDurationOverride } from "@/components/projects/project-duration-field";
import { updateProjectSchema, updateProjectRequestOriginFieldsSchema } from "@/lib/validations";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; }
}

check("same day = 0", calculateProjectDurationDays("2026-10-01", "2026-10-01") === 0);
check("Thu 2026-10-01 -> Mon 2026-10-05 = 2 working days", calculateProjectDurationDays("2026-10-01", "2026-10-05") === 2);
check("across DST, weekend only (Sat 2026-03-28 -> Mon 2026-03-30) = 0", calculateProjectDurationDays(new Date("2026-03-28"), new Date("2026-03-30")) === 0);
check("missing date -> null", calculateProjectDurationDays(null, "2026-10-05") === null && calculateProjectDurationDays("2026-10-05", undefined) === null);
check("finish before start -> null", calculateProjectDurationDays("2026-10-05", "2026-10-01") === null);
check("invalid date -> null", calculateProjectDurationDays("nope", "2026-10-01") === null);

const auto = resolveProjectDuration({ start: "2026-10-01", finish: "2026-10-05", override: undefined });
check("no override, no current -> automatic calculated (2 working days)", auto.value === 2 && auto.overridden === false);
const manual = resolveProjectDuration({ start: "2026-10-01", finish: "2026-10-05", override: 9 });
check("numeric override -> manual", manual.value === 9 && manual.overridden === true);
const zero = resolveProjectDuration({ start: "2026-10-01", finish: "2026-10-05", override: 0 });
check("zero override -> manual 0", zero.value === 0 && zero.overridden === true);
const keep = resolveProjectDuration({ start: "2027-01-01", finish: "2027-12-31", override: undefined, current: { value: 9, overridden: true } });
check("undefined override keeps an existing manual value despite new dates", keep.value === 9 && keep.overridden === true);
const recalc = resolveProjectDuration({ start: "2027-01-01", finish: "2027-01-11", override: undefined, current: { value: 4, overridden: false } });
check("undefined override in automatic mode recalculates from new dates (Fri 2027-01-01 -> Mon 2027-01-11 = 6)", recalc.value === 6 && recalc.overridden === false);
const reset = resolveProjectDuration({ start: "2027-01-01", finish: "2027-01-11", override: null, current: { value: 9, overridden: true } });
check("null override resets manual -> automatic (6)", reset.value === 6 && reset.overridden === false);

check("parse: null (automatic) -> ok null", (() => { const r = parseDurationOverride(null); return r.ok && r.value === null; })());
check("parse: '0' -> 0", (() => { const r = parseDurationOverride("0"); return r.ok && r.value === 0; })());
check("parse: ' 12 ' -> 12", (() => { const r = parseDurationOverride(" 12 "); return r.ok && r.value === 12; })());
check("parse: '-1', '2.5', '', 'abc' rejected", ["-1", "2.5", "", "abc"].every((t) => !parseDurationOverride(t).ok));

check("schema: actualTotalDaysOverride accepts 0 / null / omitted", [0, null, undefined].every((v) => updateProjectSchema.safeParse({ actualTotalDaysOverride: v }).success));
check("schema: actualTotalDaysOverride rejects -1 and 2.5", !updateProjectSchema.safeParse({ actualTotalDaysOverride: -1 }).success && !updateProjectSchema.safeParse({ actualTotalDaysOverride: 2.5 }).success);
check("schema: expectedTotalInitialDaysOverride rejects -1 and 1.5, accepts 0", !updateProjectRequestOriginFieldsSchema.safeParse({ expectedTotalInitialDaysOverride: -1 }).success && !updateProjectRequestOriginFieldsSchema.safeParse({ expectedTotalInitialDaysOverride: 1.5 }).success && updateProjectRequestOriginFieldsSchema.safeParse({ expectedTotalInitialDaysOverride: 0 }).success);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
