/**
 * Migration safety coverage for
 * prisma/migrations/20261125120000_add_project_duration_overrides.
 *
 * PART A runs the REAL migration.sql against representative pre-migration
 * fixture rows inside an isolated scratch schema, all within ONE
 * transaction that is always rolled back — nothing is persisted and the
 * real "Project" table is never touched (search_path is pinned to the
 * scratch schema). Verifies:
 *   - every existing expectedTotalInitialDays value is preserved EXACTLY
 *   - only values that differ from their calculated duration (or whose
 *     dates are missing) are flagged as manual overrides
 *   - actualTotalDays is initialized identically to the canonical resolver
 *     (lib/project-duration.ts), including missing dates, End < Start,
 *     non-midnight timestamps, and Facilities Quarter boundary dates
 *
 * PART B (read-only) cross-checks the already-migrated LOCAL database: every
 * Project's automatic durations equal the resolver's result.
 *
 * Local/dev database only. Never run against production.
 *
 * Usage: npx tsx scripts/test-project-duration-migration.ts
 */
import fs from "fs/promises";
import { PrismaClient } from "@prisma/client";
import { calculateProjectDurationDays } from "@/lib/project-duration";

/**
 * CALENDAR-day reference (finish - start) — test-only. The already-applied
 * migration 20261125120000 deliberately compares/initializes in calendar
 * days: every pre-existing stored duration was produced by the former
 * calendar-day rule, so that is the only correct basis for deciding which
 * historical values were still automatic. Do NOT replace this with the
 * working-day calculation — see scripts/report-working-days-impact.ts for
 * the separate, approval-gated working-day transition.
 */
function calendarDays(start: Date | null, finish: Date | null): number | null {
  if (!start || !finish) return null;
  const a = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const b = Date.UTC(finish.getUTCFullYear(), finish.getUTCMonth(), finish.getUTCDate());
  const days = Math.round((b - a) / 86400000);
  return days < 0 ? null : days;
}

const prisma = new PrismaClient();
let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Same boundaries as quarterStartDate/quarterEndDate (project-facilities-service.ts).
const qStart = (q: number, y: number) => new Date(Date.UTC(y, q * 3, 1));
const qEnd = (q: number, y: number) => new Date(Date.UTC(y, q * 3 + 3, 0));
const d = (iso: string) => new Date(iso);
// Prisma persists DateTime into "timestamp without time zone" as UTC wall-clock
// time. Raw-binding a JS Date would instead go through the session TimeZone,
// so fixtures are inserted as UTC wall-clock text — exactly what the app stores.
const utcWall = (v: Date | null) => (v ? v.toISOString().replace("T", " ").replace("Z", "") : null);

interface Fixture {
  id: string;
  note: string;
  expectedTotalInitialDays: number | null;
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  expectOverridden: boolean;
}

const FIXTURES: Fixture[] = [
  { id: "match", note: "baseline matches its dates", expectedTotalInitialDays: 4, expectedStartDate: d("2026-10-01"), expectedFinishDate: d("2026-10-05"), startDate: d("2026-10-02"), endDate: d("2026-10-09"), expectOverridden: false },
  { id: "match-zero", note: "same-day baseline (0)", expectedTotalInitialDays: 0, expectedStartDate: d("2026-10-01"), expectedFinishDate: d("2026-10-01"), startDate: d("2026-10-01"), endDate: d("2026-10-01"), expectOverridden: false },
  { id: "mismatch", note: "dates edited after creation (baseline 4, dates now 151 days)", expectedTotalInitialDays: 4, expectedStartDate: d("2026-01-01"), expectedFinishDate: d("2026-06-01"), startDate: null, endDate: null, expectOverridden: true },
  { id: "mismatch-start-missing", note: "baseline kept after Expected Start cleared", expectedTotalInitialDays: 7, expectedStartDate: null, expectedFinishDate: d("2026-06-01"), startDate: null, endDate: null, expectOverridden: true },
  { id: "mismatch-both-missing", note: "baseline kept after both Expected dates cleared", expectedTotalInitialDays: 12, expectedStartDate: null, expectedFinishDate: null, startDate: null, endDate: null, expectOverridden: true },
  { id: "null-with-dates", note: "no baseline but both dates (legacy)", expectedTotalInitialDays: null, expectedStartDate: d("2026-10-01"), expectedFinishDate: d("2026-10-05"), startDate: null, endDate: null, expectOverridden: false },
  { id: "null-no-dates", note: "manual Project, nothing set", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: null, endDate: null, expectOverridden: false },
  { id: "dst", note: "range across a DST change", expectedTotalInitialDays: 2, expectedStartDate: d("2026-03-28"), expectedFinishDate: d("2026-03-30"), startDate: d("2026-10-24"), endDate: d("2026-10-26"), expectOverridden: false },
  { id: "non-midnight", note: "timestamps with a time component", expectedTotalInitialDays: 1, expectedStartDate: d("2026-10-01T22:30:00Z"), expectedFinishDate: d("2026-10-02T01:15:00Z"), startDate: d("2026-10-01T23:59:00Z"), endDate: d("2026-10-03T00:01:00Z"), expectOverridden: false },
  { id: "actual-start-only", note: "only Start Date set", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: d("2026-05-01"), endDate: null, expectOverridden: false },
  { id: "actual-end-only", note: "only End Date set", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: null, endDate: d("2026-05-01"), expectOverridden: false },
  { id: "actual-reversed", note: "End before Start", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: d("2026-05-10"), endDate: d("2026-05-01"), expectOverridden: false },
  { id: "fac-q2-q2", note: "Facilities Q2 2027 -> Q2 2027", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: qStart(1, 2027), endDate: qEnd(1, 2027), expectOverridden: false },
  { id: "fac-q4-q1", note: "Facilities Q4 2026 -> Q1 2027 (leap-free year boundary)", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: qStart(3, 2026), endDate: qEnd(0, 2027), expectOverridden: false },
  { id: "fac-q1-leap", note: "Facilities Q1 2028 (leap year)", expectedTotalInitialDays: null, expectedStartDate: null, expectedFinishDate: null, startDate: qStart(0, 2028), endDate: qEnd(0, 2028), expectOverridden: false },
  { id: "fac-exact-quarter", note: "Facilities Exact start -> Quarter end", expectedTotalInitialDays: 30, expectedStartDate: d("2026-01-01"), expectedFinishDate: d("2026-01-31"), startDate: d("2026-02-15"), endDate: qEnd(1, 2026), expectOverridden: false },
];

async function partA() {
  console.log("\n=== PART A — real migration.sql against fixture rows (isolated schema, rolled back) ===\n");
  const sql = await fs.readFile("prisma/migrations/20261125120000_add_project_duration_overrides/migration.sql", "utf8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  check("migration.sql parsed into 3 statements (ALTER + 2 UPDATEs)", statements.length === 3, String(statements.length));

  const schema = `dur_migration_check_${Date.now()}`;
  const ROLLBACK = new Error("intentional rollback");
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      // Pre-migration shape of the columns the migration reads/writes —
      // same column types as production ("timestamp(3) without time zone").
      await tx.$executeRawUnsafe(`CREATE TABLE "Project" (
        "id" TEXT PRIMARY KEY,
        "expectedStartDate" TIMESTAMP(3),
        "expectedFinishDate" TIMESTAMP(3),
        "expectedTotalInitialDays" INTEGER,
        "startDate" TIMESTAMP(3),
        "endDate" TIMESTAMP(3)
      )`);
      for (const f of FIXTURES) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "Project" ("id","expectedStartDate","expectedFinishDate","expectedTotalInitialDays","startDate","endDate") VALUES ($1,$2::timestamp(3),$3::timestamp(3),$4,$5::timestamp(3),$6::timestamp(3))`,
          f.id, utcWall(f.expectedStartDate), utcWall(f.expectedFinishDate), f.expectedTotalInitialDays, utcWall(f.startDate), utcWall(f.endDate)
        );
      }
      for (const stmt of statements) await tx.$executeRawUnsafe(stmt);

      const rows = await tx.$queryRawUnsafe<
        { id: string; expectedTotalInitialDays: number | null; expectedTotalInitialDaysOverridden: boolean; actualTotalDays: number | null; actualTotalDaysOverridden: boolean }[]
      >(`SELECT "id","expectedTotalInitialDays","expectedTotalInitialDaysOverridden","actualTotalDays","actualTotalDaysOverridden" FROM "Project"`);
      const byId = new Map(rows.map((r) => [r.id, r]));
      check(`all ${FIXTURES.length} fixture rows present after migration`, rows.length === FIXTURES.length);

      for (const f of FIXTURES) {
        const r = byId.get(f.id)!;
        const calcExpected = calendarDays(f.expectedStartDate, f.expectedFinishDate);
        const calcActual = calendarDays(f.startDate, f.endDate);
        check(`[${f.id}] ${f.note}: expectedTotalInitialDays preserved exactly (${f.expectedTotalInitialDays})`, r.expectedTotalInitialDays === f.expectedTotalInitialDays, String(r.expectedTotalInitialDays));
        check(
          `[${f.id}] ...override flag = ${f.expectOverridden} (stored ${f.expectedTotalInitialDays} vs calculated ${calcExpected})`,
          r.expectedTotalInitialDaysOverridden === f.expectOverridden
        );
        // Independent of the hand-written expectation: flag <=> stored value differs from the resolver.
        const differs = f.expectedTotalInitialDays !== null && f.expectedTotalInitialDays !== calcExpected;
        check(`[${f.id}] ...flag agrees with the calendar-day rule the stored values were produced by`, r.expectedTotalInitialDaysOverridden === differs);
        check(`[${f.id}] ...actualTotalDays initialized = calendar days (${calcActual}) — see the working-day transition note`, r.actualTotalDays === calcActual, String(r.actualTotalDays));
        check(`[${f.id}] ...actualTotalDays starts in automatic mode`, r.actualTotalDaysOverridden === false);
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  const leftover = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM information_schema.schemata WHERE schema_name = $1`, schema);
  check("scratch schema rolled back — nothing persisted", leftover[0].n === 0);
}

async function partB() {
  console.log("\n=== PART B — read-only cross-check of the migrated LOCAL database ===\n");
  const projects = await prisma.project.findMany({
    select: { id: true, expectedStartDate: true, expectedFinishDate: true, expectedTotalInitialDays: true, expectedTotalInitialDaysOverridden: true, startDate: true, endDate: true, actualTotalDays: true, actualTotalDaysOverridden: true, facilitiesStartPrecision: true, facilitiesEndPrecision: true },
  });
  // A stored automatic value is consistent if it equals EITHER the
  // historical calendar-day value (not yet transitioned) OR the working-day
  // value (recalculated since, e.g. its dates changed) — anything else would
  // mean a corrupted or misclassified row.
  const consistent = (stored: number | null, s: Date | null, f: Date | null) => stored === calendarDays(s, f) || stored === calculateProjectDurationDays(s, f);
  const autoExpectedBad = projects.filter((p) => !p.expectedTotalInitialDaysOverridden && p.expectedTotalInitialDays !== null && !consistent(p.expectedTotalInitialDays, p.expectedStartDate, p.expectedFinishDate));
  const autoActualBad = projects.filter((p) => !p.actualTotalDaysOverridden && !consistent(p.actualTotalDays, p.startDate, p.endDate));
  const quarterRows = projects.filter((p) => p.facilitiesStartPrecision === "QUARTER" || p.facilitiesEndPrecision === "QUARTER");
  console.log(`  (local DB: ${projects.length} Projects, ${projects.filter((p) => p.expectedTotalInitialDays !== null).length} with Expected Total Initial Days, ${projects.filter((p) => p.actualTotalDays !== null).length} with Actual Total Days, ${quarterRows.length} with Quarter precision, ${projects.filter((p) => p.expectedTotalInitialDaysOverridden).length} Expected / ${projects.filter((p) => p.actualTotalDaysOverridden).length} Actual overrides)`);
  check("every automatic Expected Total Initial Days is a valid calendar-day (historical) or working-day value — none misclassified", autoExpectedBad.length === 0, autoExpectedBad.map((p) => p.id).join(","));
  check("every automatic Actual Total Days is a valid calendar-day (historical) or working-day value (incl. Quarter-derived dates)", autoActualBad.length === 0, autoActualBad.map((p) => p.id).join(","));
}

async function main() {
  try {
    await partA();
    await partB();
  } finally {
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
