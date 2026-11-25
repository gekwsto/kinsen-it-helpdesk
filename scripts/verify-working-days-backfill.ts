/**
 * End-to-end verification of the working-day backfill
 * (scripts/working-days-backfill/) — ONLY against DISPOSABLE databases
 * created and dropped by this script. The database named in DATABASE_URL is
 * only ever READ (to clone it and to prove it was left untouched).
 *
 *   S1  Fresh deployment: empty DB -> all migrations -> backfill is a no-op;
 *       records created through the canonical resolver need no backfill.
 *   S2  Production-like upgrade: pre-feature schema (migrations up to, not
 *       including, 20261125120000) seeded with legacy calendar-day records
 *       and every edge case -> new migrations -> report -> apply. Verifies
 *       eligibility per record, preservation of dates/statuses/completion
 *       timestamps/rate snapshots/updatedAt/manual values, costs and
 *       rollups, ledger rows, repeat execution, rollback (exact restore),
 *       rollback conflict guard, re-apply determinism, and atomicity (a
 *       failure mid-run writes nothing).
 *   S3  Upgrade of a CLONE of the current local database -> apply ->
 *       cross-view consistency invariants -> rollback; then proves the real
 *       local database was not modified.
 *
 * Usage: npx tsx scripts/verify-working-days-backfill.ts
 */
import { execFileSync } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PrismaClient, Prisma } from "@prisma/client";
import { calculateWorkingDays, actualDaysFromCompletion } from "@/lib/date-only";
import { computeProjectFinancials } from "@/lib/services/project-financials-service";
import { resolveProjectDuration } from "@/lib/project-duration";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const BASE_URL = process.env.DATABASE_URL!;
const RUN = Date.now();
const NEW_MIGRATIONS = ["20261125120000_add_project_duration_overrides", "20261126090000_add_duration_backfill_ledger"];
const urlFor = (db: string) => { const u = new URL(BASE_URL); u.pathname = `/${db}`; return u.toString(); };
const sourceDbName = new URL(BASE_URL).pathname.slice(1);
const admin = new PrismaClient({ datasources: { db: { url: urlFor("postgres") } } });
const created: string[] = [];

async function createDb(name: string, template?: string) {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
  created.push(name);
}
function run(cmd: string, args: string[], dbUrl: string): string {
  return execFileSync(cmd, args, { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
const migrateDeploy = (dbUrl: string, schemaPath = "prisma/schema.prisma") => run("npx", ["prisma", "migrate", "deploy", "--schema", schemaPath], dbUrl);
const cli = (dbUrl: string, ...args: string[]) => run("npx", ["tsx", "scripts/working-days-backfill/cli.ts", ...args], dbUrl);
const cliJson = (dbUrl: string, ...args: string[]) => JSON.parse(cli(dbUrl, ...args));
const APPLY = ["apply", "--confirm", "APPLY WORKING DAYS BACKFILL"];
const ROLLBACK = (id: string, ...extra: string[]) => ["rollback", "--run", id, "--confirm", "ROLLBACK WORKING DAYS BACKFILL", ...extra];

/** Every column the backfill must never touch, plus the ones it may — for exact before/after comparison. */
async function snapshot(db: PrismaClient) {
  const projects = await db.$queryRawUnsafe<any[]>(`SELECT id, "expectedStartDate", "expectedFinishDate", "startDate", "endDate", status::text, "updatedAt", "expectedTotalInitialDays", "expectedTotalInitialDaysOverridden", "actualTotalDays", "actualTotalDaysOverridden", "facilitiesEstimatedCost"::text, "facilitiesActualCost"::text FROM "Project" ORDER BY id`);
  const activities = await db.$queryRawUnsafe<any[]>(`SELECT id, "expectedStartDate", "expectedFinishDate", "startDate", "completedAt", status::text, "isCompleted", "updatedAt", "taskSubTypeCost"::text, "expectedDays", "actualDays" FROM "ProjectActivity" ORDER BY id`);
  return { projects, activities };
}
const PROTECTED_P = ["expectedStartDate", "expectedFinishDate", "startDate", "endDate", "status", "updatedAt", "facilitiesEstimatedCost", "facilitiesActualCost"];
const PROTECTED_A = ["expectedStartDate", "expectedFinishDate", "startDate", "completedAt", "status", "isCompleted", "updatedAt", "taskSubTypeCost"];
function protectedUnchanged(a: any[], b: any[], cols: string[]): boolean {
  const pick = (rows: any[]) => JSON.stringify(rows.map((r) => [r.id, ...cols.map((c) => (r[c] instanceof Date ? r[c].toISOString() : r[c]))]));
  return pick(a) === pick(b);
}

/** Cross-view invariant: what the Project EDIT page shows (manual -> stored; automatic -> calculated from dates) equals what the detail page/export show (stored). */
async function viewsConsistent(db: PrismaClient) {
  const ps = await db.project.findMany({ select: { id: true, expectedStartDate: true, expectedFinishDate: true, expectedTotalInitialDays: true, expectedTotalInitialDaysOverridden: true, startDate: true, endDate: true, actualTotalDays: true, actualTotalDaysOverridden: true } });
  const bad: string[] = [];
  for (const p of ps) {
    const editExpected = p.expectedTotalInitialDaysOverridden ? p.expectedTotalInitialDays : calculateWorkingDays(p.expectedStartDate, p.expectedFinishDate);
    const editActual = p.actualTotalDaysOverridden ? p.actualTotalDays : calculateWorkingDays(p.startDate, p.endDate);
    if (editExpected !== p.expectedTotalInitialDays) bad.push(`${p.id}.expected ${editExpected}!=${p.expectedTotalInitialDays}`);
    if (editActual !== p.actualTotalDays) bad.push(`${p.id}.actual ${editActual}!=${p.actualTotalDays}`);
  }
  return bad;
}

// ═══════════════════════════════ S1 ═══════════════════════════════
async function s1() {
  console.log("\n=== S1. Fresh deployment ===\n");
  const name = `kh_wd_fresh_${RUN}`;
  await createDb(name);
  const url = urlFor(name);
  migrateDeploy(url);
  const report = cliJson(url, "report");
  check("Empty fresh DB: report plans 0 writes", report.fieldsToWrite === 0);
  const out = cliJson(url, ...APPLY);
  check("Empty fresh DB: apply is a no-op (no run recorded)", out.runId === null);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const owner = await db.user.create({ data: { email: `wd-fresh-${RUN}@kinsen.gr` } });
    for (const [s, f] of [["2026-10-01", "2026-10-05"], ["2026-03-02", "2026-03-16"], ["2027-04-01", "2027-06-30"]]) {
      const d = resolveProjectDuration({ start: s, finish: f, override: undefined });
      await db.project.create({ data: { title: `fresh ${s}`, ownerId: owner.id, startDate: new Date(s), endDate: new Date(f), actualTotalDays: d.value, actualTotalDaysOverridden: d.overridden, expectedStartDate: new Date(s), expectedFinishDate: new Date(f), expectedTotalInitialDays: d.value } });
    }
    const after = cliJson(url, "report");
    check("Records created through the canonical resolver need NO backfill (0 writes, all ALREADY_WORKING)", after.fieldsToWrite === 0 && after.categoriesByField["Project.actualTotalDays"].ALREADY_WORKING === 3);
    check("Fresh DB: edit/detail views consistent", (await viewsConsistent(db)).length === 0);
  } finally {
    await db.$disconnect();
  }
}

// ═══════════════════════════════ S2 ═══════════════════════════════
async function s2() {
  console.log("\n=== S2. Production-like upgrade from the pre-feature schema ===\n");
  const name = `kh_wd_legacy_${RUN}`;
  await createDb(name);
  const url = urlFor(name);
  // Pre-feature schema: every migration EXCEPT the two new ones.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kh-wd-legacy-"));
  await fs.mkdir(path.join(tmp, "migrations"));
  await fs.copyFile("prisma/schema.prisma", path.join(tmp, "schema.prisma"));
  for (const entry of await fs.readdir("prisma/migrations")) {
    if (NEW_MIGRATIONS.includes(entry)) continue;
    await fs.cp(path.join("prisma/migrations", entry), path.join(tmp, "migrations", entry), { recursive: true });
  }
  migrateDeploy(url, path.join(tmp, "schema.prisma"));
  const cols = await admin.$queryRawUnsafe<any[]>(`SELECT 1`); void cols;
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const hasOverrideCol = await db.$queryRawUnsafe<any[]>(`SELECT 1 FROM information_schema.columns WHERE table_name='Project' AND column_name='actualTotalDays'`);
    check("Legacy DB really is pre-feature (no actualTotalDays column yet)", hasOverrideCol.length === 0);

    // ── Legacy fixtures, exactly as the former calendar-day code stored them ──
    const T = (iso: string | null) => (iso ? iso.replace("T", " ").replace("Z", "") : null);
    const q = (sql: string, ...p: unknown[]) => db.$executeRawUnsafe(sql, ...p);
    await q(`INSERT INTO "User"(id,email,"updatedAt") VALUES('u1','wd-legacy-${RUN}@kinsen.gr',now())`);
    await q(`INSERT INTO "Department"(id,name,slug,"updatedAt") VALUES('d1','WD Legacy','wd-legacy-${RUN}',now())`);
    for (const [id, meta] of [["prA", `{"originalTotalDays":10}`], ["prB", `{"originalTotalDays":99}`]] as const) {
      await q(`INSERT INTO "ProjectRequest"(id,title,"departmentId","updatedAt",source,status,"historicalSourceMetadata","externalSourceId") VALUES($1,$1,'d1',now(),'HISTORICAL_IMPORT','IMPORTED',$2::jsonb,$1)`, id, meta);
    }
    const P = async (id: string, f: { es?: string; ef?: string; eti?: number | null; s?: string; e?: string; pr?: string; qs?: string; qe?: string }) =>
      q(`INSERT INTO "Project"(id,title,"ownerId","updatedAt","departmentId","expectedStartDate","expectedFinishDate","expectedTotalInitialDays","startDate","endDate","projectRequestId","facilitiesStartPrecision","facilitiesEndPrecision") VALUES($1,$1,'u1','2026-01-01 00:00:00','d1',$2::timestamp,$3::timestamp,$4,$5::timestamp,$6::timestamp,$7,$8::"ProjectDatePrecision",$9::"ProjectDatePrecision")`,
        id, T(f.es ?? null), T(f.ef ?? null), f.eti ?? null, T(f.s ?? null), T(f.e ?? null), f.pr ?? null, f.qs ?? null, f.qe ?? null);
    await P("P1", { es: "2026-10-01", ef: "2026-10-05", eti: 4, s: "2026-10-02", e: "2026-10-09" }); // both calendar
    await P("P2", { es: "2026-01-01", ef: "2026-06-01", eti: 4 }); // dates edited after creation
    await P("P3", { es: "2025-01-01", ef: "2025-01-11", eti: 10, pr: "prA" }); // equals explicit source total 10
    await P("P4", { es: "2025-01-01", ef: "2025-01-11", eti: 10, pr: "prB" }); // import, source total 99 -> date-derived
    await P("P5", { s: "2026-03-02", e: "2026-03-16" }); // manual Project
    await P("P6", { es: "2026-10-05", ef: "2026-10-19", eti: null }); // automatic, never filled
    await P("P7", { s: "2026-05-10", e: "2026-05-01" }); // reversed actual dates
    await P("P8", { s: "2027-04-01", e: "2027-06-30", qs: "QUARTER", qe: "QUARTER" }); // Facilities Q2 2027
    const A = async (id: string, f: { es?: string; ef?: string; ed?: number | null; s?: string; c?: string; ad?: number | null; rate?: string | null; status?: string }) =>
      q(`INSERT INTO "ProjectActivity"(id,title,"updatedAt","projectId","departmentId","expectedStartDate","expectedFinishDate","expectedDays","startDate","completedAt","actualDays","taskSubTypeCost",status,"isCompleted") VALUES($1,$1,'2026-01-01 00:00:00','P1','d1',$2::timestamp,$3::timestamp,$4,$5::timestamp,$6::timestamp,$7,$8::numeric,$9::"ActivityStatus",$10)`,
        id, T(f.es ?? null), T(f.ef ?? null), f.ed ?? null, T(f.s ?? null), T(f.c ?? null), f.ad ?? null, f.rate ?? null, f.status ?? "TODO", (f.status ?? "TODO") === "COMPLETED");
    await A("A1", { es: "2026-09-20", ef: "2026-10-02", ed: 12, c: "2026-10-10T14:30:00Z", ad: 20, rate: "150.00", status: "COMPLETED" }); // completed, both calendar
    await A("A2", { es: "2026-09-20", ef: "2026-10-05", ed: 12, rate: "200.00" }); // expected dates edited, expectedDays not recomputed
    await A("A3", { es: "2026-10-10", ef: "2026-10-15", ed: 5, c: "2026-10-08T09:00:00Z", ad: 0, rate: "100.00", status: "COMPLETED" }); // completed early (clamped 0)
    await A("A4", { es: "2026-09-01", ef: "2026-09-10", ed: 9, c: "2026-09-30T10:00:00Z", ad: 25, rate: "50.00", status: "COMPLETED" }); // start edited after completion
    await A("A5", { s: "2026-03-02", c: "2026-03-16T08:00:00Z", ad: 14, rate: null, status: "COMPLETED" }); // manual: Actual Start reference
    await A("A6", { es: "2026-10-05", ef: "2026-10-09", ed: 4, rate: "80.00" }); // Mon->Fri: calendar == working
    await A("A7", { s: "2026-03-02", c: "2026-03-16T08:00:00Z", ad: null, rate: "70.00", status: "COMPLETED" }); // completed, no actualDays recorded

    // ── New migrations (as on production) ──
    migrateDeploy(url);
    const post = await db.project.findMany({ orderBy: { id: "asc" }, select: { id: true, expectedTotalInitialDays: true, expectedTotalInitialDaysOverridden: true, actualTotalDays: true, actualTotalDaysOverridden: true } });
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    const m1 = byId(post);
    check("Migration 20261125120000 behaves as reviewed: P2 (edited dates) flagged manual, P1 automatic, Actual initialized in calendar days (P1=7, P5=14, P8=90)", m1.P2.expectedTotalInitialDaysOverridden && !m1.P1.expectedTotalInitialDaysOverridden && m1.P1.actualTotalDays === 7 && m1.P5.actualTotalDays === 14 && m1.P8.actualTotalDays === 90);

    const before = await snapshot(db);
    const report = cliJson(url, "report");
    const out = cliJson(url, ...APPLY);
    check("Apply records a run", typeof out.runId === "string");
    const after = await snapshot(db);
    const pa = byId(after.projects), aa = byId(after.activities);
    const W = (s: string, f: string) => calculateWorkingDays(s, f);

    console.log("\n-- Eligibility outcomes --\n");
    check("A (Actual Total Days, new column): P1 7 -> 5, P5 14 -> 10, Facilities Quarter P8 90 -> 64", pa.P1.actualTotalDays === 5 && pa.P5.actualTotalDays === 10 && pa.P8.actualTotalDays === 64 && !pa.P8.actualTotalDaysOverridden);
    check("B: P1 Expected 4 -> 2 (proven calendar-derived), stays automatic", pa.P1.expectedTotalInitialDays === 2 && !pa.P1.expectedTotalInitialDaysOverridden);
    check("B: P2 manual (flagged by the earlier migration) preserved exactly (4, manual)", pa.P2.expectedTotalInitialDays === 4 && pa.P2.expectedTotalInitialDaysOverridden);
    check("B: P3 equals the import's EXPLICIT source total -> value preserved (10), protected as manual, reported", pa.P3.expectedTotalInitialDays === 10 && pa.P3.expectedTotalInitialDaysOverridden);
    check("B: P4 historical import whose value is provably date-derived -> converted 10 -> 8 (origin alone never decides)", pa.P4.expectedTotalInitialDays === 8 && !pa.P4.expectedTotalInitialDaysOverridden);
    check("B: P6 automatic but never filled -> filled with working days (Mon 10-05 -> Mon 10-19 = 10)", pa.P6.expectedTotalInitialDays === 10);
    check("P7 reversed dates -> stays null", pa.P7.actualTotalDays === null);
    check("C1: A1 Expected 12 -> 9 (completed Activity, regardless of status)", aa.A1.expectedDays === 9);
    check("C1: A2 expectedDays not derivable from its current dates -> preserved (12), reported", aa.A2.expectedDays === 12);
    check("C1: A6 Mon->Fri already identical in both rules (4)", aa.A6.expectedDays === 4);
    check(`C2: A1 completed Actual 20 -> ${actualDaysFromCompletion(new Date("2026-09-20"), new Date("2026-10-10T14:30:00Z"))} working days`, aa.A1.actualDays === actualDaysFromCompletion(new Date("2026-09-20"), new Date("2026-10-10T14:30:00Z")));
    check("C2: A3 early completion stays 0", aa.A3.actualDays === 0);
    check("C2: A4 start reference edited after completion -> preserved (25), reported", aa.A4.actualDays === 25);
    check("C2: A5 Actual-Start reference 14 -> 10", aa.A5.actualDays === 10);
    check("C2: A7 completed without a recorded actualDays stays null (never fabricated)", aa.A7.actualDays === null);
    const unverified = (report.categoriesByField["ProjectActivity.expectedDays"].PRESERVE_UNVERIFIED ?? 0) + (report.categoriesByField["ProjectActivity.actualDays"].PRESERVE_UNVERIFIED ?? 0);
    check("Report lists ambiguous/unverified records separately (P3 ambiguous, A2 + A4 unverified)", report.categoriesByField["Project.expectedTotalInitialDays"].PRESERVE_AMBIGUOUS_SOURCE_TOTAL === 1 && unverified === 2);

    console.log("\n-- Preservation --\n");
    check("Dates, statuses, completion timestamps, isCompleted, rate snapshots and updatedAt unchanged (Activities)", protectedUnchanged(before.activities, after.activities, PROTECTED_A));
    check("Dates, status, updatedAt and Facilities manual costs unchanged (Projects)", protectedUnchanged(before.projects, after.projects, PROTECTED_P));

    console.log("\n-- Financial consistency --\n");
    const acts = await db.projectActivity.findMany({ where: { projectId: "P1" }, select: { taskSubTypeCost: true, expectedDays: true, actualDays: true } });
    const roll = computeProjectFinancials(acts);
    const exp = new Prisma.Decimal(150).times(9).plus(new Prisma.Decimal(200).times(12)).plus(new Prisma.Decimal(100).times(W("2026-10-10", "2026-10-15")!)).plus(new Prisma.Decimal(50).times(W("2026-09-01", "2026-09-10")!)).plus(new Prisma.Decimal(80).times(4));
    // A3's expectedDays 5 (Sat 10-10 -> Thu 10-15) is calendar-derived too -> converted to 3.
    check(`A3 Expected 5 -> ${W("2026-10-10", "2026-10-15")} (calendar-derived)`, aa.A3.expectedDays === W("2026-10-10", "2026-10-15"));
    check(`P1 Estimated rollup = Σ original rate × effective working days = ${exp.toFixed(2)}`, roll.estimatedCost.equals(exp), roll.estimatedCost.toFixed(2));
    const expActual = new Prisma.Decimal(150).times(aa.A1.actualDays).plus(new Prisma.Decimal(50).times(25));
    check(`P1 Actual rollup = completed Activities' original rate × working days (+ preserved A4) = ${expActual.toFixed(2)}`, roll.actualCost.equals(expActual), roll.actualCost.toFixed(2));
    check("Report's 'after' financial totals equal the canonical rollup computed from the database afterwards", report.financial.estimatedCostAfterEUR === exp.toFixed(2) && report.financial.actualCostAfterEUR === expActual.toFixed(2));
    check("Edit page / detail page / export values consistent for every Project", (await viewsConsistent(db)).length === 0, (await viewsConsistent(db)).join("; "));

    console.log("\n-- Ledger, idempotency, rollback --\n");
    const changes = await db.durationBackfillChange.count({ where: { runId: out.runId } });
    check(`One backup row per changed field (${changes} = planned ${report.fieldsToWrite})`, changes === report.fieldsToWrite);
    const again = cliJson(url, ...APPLY);
    check("Repeat apply: nothing to do, no second run, no change", again.runId === null && JSON.stringify(await snapshot(db)) === JSON.stringify(after));
    cliJson(url, ...ROLLBACK(out.runId));
    const rolled = await snapshot(db);
    check("Rollback restores every value and override flag exactly (full snapshot equal to pre-apply)", JSON.stringify(rolled) === JSON.stringify(before));
    check("Run marked ROLLED_BACK", (await db.durationBackfillRun.findUniqueOrThrow({ where: { id: out.runId } })).status === "ROLLED_BACK");
    const out2 = cliJson(url, ...APPLY);
    check("Re-apply after rollback is deterministic (identical result)", JSON.stringify(await snapshot(db)) === JSON.stringify(after));

    // Conflict guard: a value edited after the run is never clobbered by rollback.
    await db.$executeRawUnsafe(`UPDATE "ProjectActivity" SET "expectedDays" = 99 WHERE id = 'A1'`);
    let aborted = false;
    try { cli(url, ...ROLLBACK(out2.runId)); } catch { aborted = true; }
    check("Rollback with a conflicting later edit aborts and restores NOTHING", aborted && (await db.project.findUniqueOrThrow({ where: { id: "P1" } })).actualTotalDays === 5);
    const partial = cliJson(url, ...ROLLBACK(out2.runId, "--skip-conflicts"));
    check("--skip-conflicts restores everything else and reports the conflict; the later edit (99) is kept", partial.conflicts.length === 1 && (await db.projectActivity.findUniqueOrThrow({ where: { id: "A1" } })).expectedDays === 99 && (await db.project.findUniqueOrThrow({ where: { id: "P1" } })).actualTotalDays === 7);

    // Atomicity: a failure part-way through writes nothing.
    await db.$executeRawUnsafe(`UPDATE "ProjectActivity" SET "expectedDays" = 12 WHERE id = 'A1'`);
    const pre = await snapshot(db);
    const runsBefore = await db.durationBackfillRun.count();
    await db.$executeRawUnsafe(`CREATE FUNCTION wd_fail() RETURNS trigger AS $$ BEGIN IF NEW.id = 'A5' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER wd_fail BEFORE UPDATE ON "ProjectActivity" FOR EACH ROW EXECUTE FUNCTION wd_fail()`);
    let failedRun = false;
    try { cli(url, ...APPLY); } catch { failedRun = true; }
    await db.$executeRawUnsafe(`DROP TRIGGER wd_fail ON "ProjectActivity"`);
    check("Injected failure mid-apply -> whole run rolled back: no value changed, no run/backup rows", failedRun && JSON.stringify(await snapshot(db)) === JSON.stringify(pre) && (await db.durationBackfillRun.count()) === runsBefore);
  } finally {
    await db.$disconnect();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════ S3 ═══════════════════════════════
async function s3() {
  console.log("\n=== S3. Upgrade of a CLONE of the current local database ===\n");
  const src = new PrismaClient({ datasources: { db: { url: BASE_URL } } });
  const original = await snapshot(src);
  const ledgerBefore = await src.$queryRawUnsafe<any[]>(`SELECT to_regclass('"DurationBackfillRun"') IS NOT NULL AS present`);
  const originalRuns = ledgerBefore[0].present ? (await src.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM "DurationBackfillRun"`))[0].n : null;
  const reportOnOriginal = JSON.parse(run("npx", ["tsx", "scripts/working-days-backfill/cli.ts", "report"], BASE_URL));
  await src.$disconnect();

  const name = `kh_wd_clone_${RUN}`;
  await createDb(name, sourceDbName);
  const url = urlFor(name);
  migrateDeploy(url);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const before = await snapshot(db);
    check("Clone matches the local database exactly before the upgrade", JSON.stringify(before) === JSON.stringify(original));
    if (reportOnOriginal.fieldsToWrite === 0) {
      // The local database has already been backfilled (approved local run):
      // the upgrade path must then be a pure no-op.
      const out = cliJson(url, ...APPLY);
      check("Local DB already backfilled: apply on the clone is a no-op (no run, nothing written)", out.runId === null && JSON.stringify(await snapshot(db)) === JSON.stringify(before));
      check("Clone: edit/detail/export views consistent for every Project", (await viewsConsistent(db)).length === 0, (await viewsConsistent(db)).join("; "));
    } else {
      const out = cliJson(url, ...APPLY);
      check(`Apply on the clone writes exactly what the read-only report on the ORIGINAL predicted (${reportOnOriginal.fieldsToWrite} fields)`, out.summary.fieldsToWrite === reportOnOriginal.fieldsToWrite && (await db.durationBackfillChange.count({ where: { runId: out.runId } })) === reportOnOriginal.fieldsToWrite);
      const after = await snapshot(db);
      check("Clone: protected columns unchanged (Projects)", protectedUnchanged(before.projects, after.projects, PROTECTED_P));
      check("Clone: protected columns unchanged (Activities, incl. completion timestamps + rate snapshots)", protectedUnchanged(before.activities, after.activities, PROTECTED_A));
      check("Clone: edit/detail/export views consistent for every Project", (await viewsConsistent(db)).length === 0, (await viewsConsistent(db)).join("; "));
      const post = cliJson(url, "report");
      check("Clone: post-apply report shows 0 remaining writes", post.fieldsToWrite === 0);
      check("Clone: post-apply financial totals equal the predicted 'after' totals", post.financial.estimatedCostBeforeEUR === reportOnOriginal.financial.estimatedCostAfterEUR && post.financial.actualCostBeforeEUR === reportOnOriginal.financial.actualCostAfterEUR);
      cliJson(url, ...ROLLBACK(out.runId));
      check("Clone: rollback restores the original data exactly", JSON.stringify(await snapshot(db)) === JSON.stringify(original));
    }
  } finally {
    await db.$disconnect();
  }
  const src2 = new PrismaClient({ datasources: { db: { url: BASE_URL } } });
  check("The real local database was NOT modified by any of this", JSON.stringify(await snapshot(src2)) === JSON.stringify(original));
  const ledgerAfter = await src2.$queryRawUnsafe<any[]>(`SELECT to_regclass('"DurationBackfillRun"') IS NOT NULL AS present`);
  const runsAfter = ledgerAfter[0].present ? (await src2.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM "DurationBackfillRun"`))[0].n : null;
  check("...and its backfill ledger is untouched (same run count as before the harness)", runsAfter === originalRuns);
  await src2.$disconnect();
}

async function main() {
  try {
    await s1();
    await s2();
    await s3();
  } finally {
    for (const name of created.reverse()) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch((e) => console.error(`drop ${name} failed`, e));
    }
    await admin.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
