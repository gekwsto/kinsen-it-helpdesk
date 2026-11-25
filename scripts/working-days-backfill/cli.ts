/**
 * Working-day duration backfill — controlled, approval-gated CLI.
 *
 *   report    READ-ONLY. Before/after per category + financial impact, and a
 *             record-level CSV of every entry that changes or is preserved.
 *   apply     ONE transaction: re-plans inside the transaction, writes a
 *             DurationBackfillRun + one DurationBackfillChange (old/new) per
 *             changed field, then applies guarded updates. Any concurrent
 *             modification aborts the whole run. Idempotent: a second apply
 *             finds nothing to do and writes nothing.
 *   rollback  ONE transaction: restores every change of a run exactly, only
 *             where the current value is still the value the run wrote
 *             (anything edited since is reported as a conflict; the rollback
 *             aborts unless --skip-conflicts).
 *   status    Lists runs.
 *   snapshot  READ-ONLY. Saves every protected + duration column to a JSON
 *             file (take it immediately before apply).
 *   validate  READ-ONLY post-backfill validation against a snapshot and a
 *             run: only the run's ledgered fields changed, each exactly
 *             old -> new; every protected column identical; a re-plan finds
 *             zero remaining writes; edit/detail values consistent; current
 *             financial totals equal the run's predicted "after" totals.
 *             Exits non-zero on any failure.
 *
 * Writes use guarded raw UPDATEs so they never touch updatedAt or any column
 * other than the duration (and, for Projects, its override flag). Dates,
 * statuses, completion timestamps, daily-rate snapshots and every monetary
 * column are never written. Costs are derived on read (rate × days) via
 * lib/services/project-financials-service.ts, so they follow automatically.
 *
 * Usage:
 *   npx tsx scripts/working-days-backfill/cli.ts report [--out <dir>]
 *   npx tsx scripts/working-days-backfill/cli.ts apply --confirm "APPLY WORKING DAYS BACKFILL" [--exclude-fill-missing]
 *   npx tsx scripts/working-days-backfill/cli.ts rollback --run <runId> --confirm "ROLLBACK WORKING DAYS BACKFILL" [--skip-conflicts]
 *   npx tsx scripts/working-days-backfill/cli.ts status
 *   npx tsx scripts/working-days-backfill/cli.ts snapshot --out <file.json>
 *   npx tsx scripts/working-days-backfill/cli.ts validate --before <file.json> --run <runId>
 * (DATABASE_URL selects the database.)
 *
 * Production: `npm run ops:build` compiles this into ONE plain-Node file,
 * dist/ops/working-days-backfill.cjs, whose only non-builtin runtime
 * dependency is @prisma/client (a production dependency) — run it with
 * `node dist/ops/working-days-backfill.cjs <command> …`; no tsx/dev deps.
 * See docs/working-days-deployment.md.
 */
import fs from "fs/promises";
import path from "path";
import { PrismaClient, Prisma } from "@prisma/client";
import { computeProjectFinancials } from "@/lib/services/project-financials-service";
import { calculateWorkingDays } from "@/lib/date-only";
import { BACKFILL_KIND, planActivity, planProject, type PlannedField } from "./plan";

const APPLY_PHRASE = "APPLY WORKING DAYS BACKFILL";
const ROLLBACK_PHRASE = "ROLLBACK WORKING DAYS BACKFILL";
const LOCK_KEY = "working-days-backfill";

type Db = PrismaClient | Prisma.TransactionClient;

// Fixed identifier whitelist — the ONLY columns this tool can ever write.
const COLUMNS: Record<PlannedField["field"], { table: string; column: string; flag?: string }> = {
  expectedTotalInitialDays: { table: "Project", column: "expectedTotalInitialDays", flag: "expectedTotalInitialDaysOverridden" },
  actualTotalDays: { table: "Project", column: "actualTotalDays", flag: "actualTotalDaysOverridden" },
  expectedDays: { table: "ProjectActivity", column: "expectedDays" },
  actualDays: { table: "ProjectActivity", column: "actualDays" },
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}
const flag = (name: string) => process.argv.includes(name);

export interface LoadedData {
  plan: PlannedField[];
  activities: { id: string; projectId: string | null; status: string; taskSubTypeCost: Prisma.Decimal | null; expectedDays: number | null; actualDays: number | null }[];
}

export async function loadPlan(db: Db, opts: { includeFillMissing: boolean }): Promise<LoadedData> {
  const projects = await db.project.findMany({
    select: {
      id: true, expectedStartDate: true, expectedFinishDate: true, expectedTotalInitialDays: true, expectedTotalInitialDaysOverridden: true,
      startDate: true, endDate: true, actualTotalDays: true, actualTotalDaysOverridden: true,
      projectRequest: { select: { historicalSourceMetadata: true } },
    },
    orderBy: { id: "asc" },
  });
  const activities = await db.projectActivity.findMany({
    select: { id: true, projectId: true, status: true, taskSubTypeCost: true, expectedStartDate: true, expectedFinishDate: true, expectedDays: true, startDate: true, completedAt: true, actualDays: true },
    orderBy: { id: "asc" },
  });
  const plan: PlannedField[] = [];
  for (const p of projects) {
    const meta = p.projectRequest?.historicalSourceMetadata as { originalTotalDays?: unknown } | null | undefined;
    const sourceTotalDays = meta && typeof meta.originalTotalDays === "number" ? meta.originalTotalDays : null;
    plan.push(...planProject({ ...p, sourceTotalDays }));
  }
  for (const a of activities) plan.push(...planActivity(a));
  if (!opts.includeFillMissing) {
    for (const e of plan) if (e.category === "FILL_MISSING") { e.writes = false; e.newValue = e.oldValue; e.note = "excluded by --exclude-fill-missing"; }
  }
  return { plan, activities };
}

export function summarize(data: LoadedData) {
  const byField: Record<string, Record<string, number>> = {};
  for (const e of data.plan) {
    const key = `${e.entity}.${e.field}`;
    byField[key] ??= {};
    byField[key][e.category] = (byField[key][e.category] ?? 0) + 1;
  }
  const newDays = new Map<string, { expectedDays: number | null; actualDays: number | null }>();
  for (const a of data.activities) newDays.set(a.id, { expectedDays: a.expectedDays, actualDays: a.actualDays });
  for (const e of data.plan) {
    if (e.entity === "ProjectActivity" && e.writes) newDays.get(e.recordId)![e.field as "expectedDays" | "actualDays"] = e.newValue;
  }
  let estBefore = new Prisma.Decimal(0), estAfter = new Prisma.Decimal(0), actBefore = new Prisma.Decimal(0), actAfter = new Prisma.Decimal(0);
  let activitiesWithCostChange = 0, completedWithActualCostChange = 0;
  const byProject = new Map<string, { before: typeof data.activities; after: typeof data.activities }>();
  for (const a of data.activities) {
    const after = { ...a, ...newDays.get(a.id)! };
    const b = computeProjectFinancials([a]);
    const f = computeProjectFinancials([after]);
    estBefore = estBefore.plus(b.estimatedCost); estAfter = estAfter.plus(f.estimatedCost);
    actBefore = actBefore.plus(b.actualCost); actAfter = actAfter.plus(f.actualCost);
    if (!b.estimatedCost.equals(f.estimatedCost) || !b.actualCost.equals(f.actualCost)) activitiesWithCostChange++;
    if (!b.actualCost.equals(f.actualCost)) completedWithActualCostChange++;
    if (a.projectId) {
      const g = byProject.get(a.projectId) ?? { before: [], after: [] };
      g.before.push(a); g.after.push(after);
      byProject.set(a.projectId, g);
    }
  }
  const projectRollups: { projectId: string; estimatedBefore: string; estimatedAfter: string; actualBefore: string; actualAfter: string }[] = [];
  for (const [projectId, g] of byProject) {
    const b = computeProjectFinancials(g.before), f = computeProjectFinancials(g.after);
    if (!b.estimatedCost.equals(f.estimatedCost) || !b.actualCost.equals(f.actualCost)) {
      projectRollups.push({ projectId, estimatedBefore: b.estimatedCost.toFixed(2), estimatedAfter: f.estimatedCost.toFixed(2), actualBefore: b.actualCost.toFixed(2), actualAfter: f.actualCost.toFixed(2) });
    }
  }
  return {
    kind: BACKFILL_KIND,
    fieldsToWrite: data.plan.filter((e) => e.writes).length,
    recordsToWrite: new Set(data.plan.filter((e) => e.writes).map((e) => `${e.entity}:${e.recordId}`)).size,
    categoriesByField: byField,
    financial: {
      basis: "derived on read: taskSubTypeCost (daily-rate snapshot, never changed) × working days",
      rateSnapshotsChanged: 0,
      monetaryColumnsWritten: 0,
      estimatedCostBeforeEUR: estBefore.toFixed(2), estimatedCostAfterEUR: estAfter.toFixed(2),
      actualCostBeforeEUR: actBefore.toFixed(2), actualCostAfterEUR: actAfter.toFixed(2),
      activitiesWithDerivedCostChange: activitiesWithCostChange,
      activitiesWithActualCostChange: completedWithActualCostChange,
      projectRollupsChanged: projectRollups.length,
      projectRollups,
    },
  };
}

function toCsv(plan: PlannedField[]): string {
  const rows = plan.filter((e) => e.writes || e.category.startsWith("PRESERVE_UNVERIFIED") || e.category === "PRESERVE_AMBIGUOUS_SOURCE_TOTAL");
  const esc = (v: unknown) => (v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`);
  return ["entity,recordId,field,category,oldValue,newValue,oldOverridden,newOverridden,writes,note", ...rows.map((e) => [e.entity, e.recordId, e.field, e.category, e.oldValue, e.newValue, e.oldOverridden, e.newOverridden, e.writes, e.note].map(esc).join(","))].join("\n");
}

/** Guarded write of ONE field (+ flag). Returns rows affected (0 = value changed since planning). */
async function guardedWrite(tx: Prisma.TransactionClient, e: { field: PlannedField["field"]; recordId: string }, from: { value: number | null; overridden?: boolean }, to: { value: number | null; overridden?: boolean }): Promise<number> {
  const c = COLUMNS[e.field];
  if (c.flag) {
    return tx.$executeRawUnsafe(
      `UPDATE "${c.table}" SET "${c.column}" = $1, "${c.flag}" = $2 WHERE "id" = $3 AND "${c.column}" IS NOT DISTINCT FROM $4 AND "${c.flag}" = $5`,
      to.value, to.overridden, e.recordId, from.value, from.overridden
    );
  }
  return tx.$executeRawUnsafe(`UPDATE "${c.table}" SET "${c.column}" = $1 WHERE "id" = $2 AND "${c.column}" IS NOT DISTINCT FROM $3`, to.value, e.recordId, from.value);
}

export async function apply(prisma: PrismaClient, opts: { includeFillMissing: boolean }) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))::text`);
      const data = await loadPlan(tx, opts); // re-planned INSIDE the transaction
      const writes = data.plan.filter((e) => e.writes);
      if (writes.length === 0) return { runId: null as string | null, summary: summarize(data) };
      const summary = summarize(data);
      const run = await tx.durationBackfillRun.create({ data: { kind: BACKFILL_KIND, summary: summary as unknown as Prisma.InputJsonValue } });
      await tx.durationBackfillChange.createMany({
        data: writes.map((e) => ({ runId: run.id, entity: e.entity, recordId: e.recordId, field: e.field, category: e.category, oldValue: e.oldValue, newValue: e.newValue, oldOverridden: e.oldOverridden ?? null, newOverridden: e.newOverridden ?? null })),
      });
      for (const e of writes) {
        const n = await guardedWrite(tx, e, { value: e.oldValue, overridden: e.oldOverridden }, { value: e.newValue, overridden: e.newOverridden });
        if (n !== 1) throw new Error(`Concurrent modification of ${e.entity} ${e.recordId}.${e.field} — whole run aborted, nothing written.`);
      }
      return { runId: run.id, summary };
    },
    { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 }
  );
}

export async function rollback(prisma: PrismaClient, runId: string, opts: { skipConflicts: boolean }) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${LOCK_KEY}'))::text`);
      const run = await tx.durationBackfillRun.findUnique({ where: { id: runId }, include: { changes: true } });
      if (!run) throw new Error(`Run ${runId} not found.`);
      if (run.status !== "APPLIED") throw new Error(`Run ${runId} is ${run.status} — nothing to roll back.`);
      const conflicts: string[] = [];
      let restored = 0;
      for (const ch of run.changes) {
        if (ch.restoredAt) continue;
        const n = await guardedWrite(
          tx,
          { field: ch.field as PlannedField["field"], recordId: ch.recordId },
          { value: ch.newValue, overridden: ch.newOverridden ?? undefined },
          { value: ch.oldValue, overridden: ch.oldOverridden ?? undefined }
        );
        if (n === 1) {
          restored++;
          await tx.durationBackfillChange.update({ where: { id: ch.id }, data: { restoredAt: new Date() } });
        } else conflicts.push(`${ch.entity} ${ch.recordId}.${ch.field} (changed or deleted since the run)`);
      }
      if (conflicts.length && !opts.skipConflicts) throw new Error(`Rollback aborted — ${conflicts.length} conflict(s), nothing restored:\n  ${conflicts.join("\n  ")}\nRe-run with --skip-conflicts to restore everything else.`);
      await tx.durationBackfillRun.update({ where: { id: runId }, data: { status: "ROLLED_BACK", rolledBackAt: new Date() } });
      return { restored, conflicts };
    },
    { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 }
  );
}

// ─── snapshot / validate ─────────────────────────────────────────────────────
const PROJECT_PROTECTED = ["expectedStartDate", "expectedFinishDate", "startDate", "endDate", "status", "updatedAt", "facilitiesEstimatedCost", "facilitiesActualCost", "facilitiesStartPrecision", "facilitiesStartQuarter", "facilitiesStartYear", "facilitiesEndPrecision", "facilitiesEndQuarter", "facilitiesEndYear"];
const ACTIVITY_PROTECTED = ["expectedStartDate", "expectedFinishDate", "startDate", "dueDate", "completedAt", "status", "isCompleted", "updatedAt", "taskSubTypeCost", "taskSubTypeId"];
const PROJECT_DURATIONS = ["expectedTotalInitialDays", "expectedTotalInitialDaysOverridden", "actualTotalDays", "actualTotalDaysOverridden"];
const ACTIVITY_DURATIONS = ["expectedDays", "actualDays"];

export async function takeSnapshot(db: Db) {
  const cols = (list: string[]) => list.map((c) => `"${c}"::text AS "${c}"`).join(", ");
  const projects = await db.$queryRawUnsafe<Record<string, string | null>[]>(`SELECT id, ${cols([...PROJECT_PROTECTED, ...PROJECT_DURATIONS])} FROM "Project" ORDER BY id`);
  const activities = await db.$queryRawUnsafe<Record<string, string | null>[]>(`SELECT id, ${cols([...ACTIVITY_PROTECTED, ...ACTIVITY_DURATIONS])} FROM "ProjectActivity" ORDER BY id`);
  return { takenAt: new Date().toISOString(), projects, activities };
}

export async function validate(prisma: PrismaClient, before: Awaited<ReturnType<typeof takeSnapshot>>, runId: string) {
  const results: { check: string; ok: boolean; detail?: string }[] = [];
  const add = (check: string, ok: boolean, detail?: string) => results.push({ check, ok, detail });
  const now = await takeSnapshot(prisma);
  const run = await prisma.durationBackfillRun.findUnique({ where: { id: runId }, include: { changes: true } });
  if (!run) throw new Error(`Run ${runId} not found.`);
  add("run is APPLIED", run.status === "APPLIED", run.status);
  const changeByKey = new Map(run.changes.map((c) => [`${c.entity}:${c.recordId}:${c.field}`, c]));
  const toNum = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  const toBool = (v: string | null | undefined) => (v === null || v === undefined ? undefined : v === "true");

  for (const [entity, beforeRows, nowRows, protectedCols, durationCols] of [
    ["Project", before.projects, now.projects, PROJECT_PROTECTED, ["expectedTotalInitialDays", "actualTotalDays"]],
    ["ProjectActivity", before.activities, now.activities, ACTIVITY_PROTECTED, ACTIVITY_DURATIONS],
  ] as const) {
    add(`${entity}: same record set as the snapshot`, beforeRows.length === nowRows.length && beforeRows.every((r, i) => r.id === nowRows[i]?.id), `${beforeRows.length} vs ${nowRows.length}`);
    const nowById = new Map(nowRows.map((r) => [r.id, r]));
    const protectedDiffs: string[] = [];
    const durationDiffs: string[] = [];
    for (const b of beforeRows) {
      const n = nowById.get(b.id);
      if (!n) continue;
      for (const c of protectedCols) if (b[c] !== n[c]) protectedDiffs.push(`${b.id}.${c}`);
      for (const field of durationCols) {
        const flagCol = field === "expectedTotalInitialDays" ? "expectedTotalInitialDaysOverridden" : field === "actualTotalDays" ? "actualTotalDaysOverridden" : null;
        const ch = changeByKey.get(`${entity}:${b.id}:${field}`);
        if (ch) {
          const okOld = toNum(b[field]) === ch.oldValue && (!flagCol || toBool(b[flagCol]) === (ch.oldOverridden ?? undefined));
          const okNew = toNum(n[field]) === ch.newValue && (!flagCol || toBool(n[flagCol]) === (ch.newOverridden ?? undefined));
          if (!okOld || !okNew) durationDiffs.push(`${b.id}.${field} ledger ${ch.oldValue}->${ch.newValue}, snapshot ${b[field]} -> now ${n[field]}`);
        } else if (b[field] !== n[field] || (flagCol && b[flagCol] !== n[flagCol])) durationDiffs.push(`${b.id}.${field} changed without a ledger entry`);
      }
    }
    add(`${entity}: every protected column unchanged (${protectedCols.join(", ")})`, protectedDiffs.length === 0, protectedDiffs.slice(0, 10).join("; "));
    add(`${entity}: duration fields changed ONLY where ledgered, exactly old -> new`, durationDiffs.length === 0, durationDiffs.slice(0, 10).join("; "));
  }

  const replan = await loadPlan(prisma, { includeFillMissing: true });
  const remaining = replan.plan.filter((e) => e.writes);
  add("idempotent: a re-plan finds 0 remaining writes", remaining.length === 0, remaining.slice(0, 5).map((e) => `${e.recordId}.${e.field}`).join("; "));

  const ps = await prisma.project.findMany({ select: { id: true, expectedStartDate: true, expectedFinishDate: true, expectedTotalInitialDays: true, expectedTotalInitialDaysOverridden: true, startDate: true, endDate: true, actualTotalDays: true, actualTotalDaysOverridden: true } });
  const viewDiffs: string[] = [];
  for (const p of ps) {
    const editExpected = p.expectedTotalInitialDaysOverridden ? p.expectedTotalInitialDays : calculateWorkingDays(p.expectedStartDate, p.expectedFinishDate);
    const editActual = p.actualTotalDaysOverridden ? p.actualTotalDays : calculateWorkingDays(p.startDate, p.endDate);
    if (editExpected !== p.expectedTotalInitialDays) viewDiffs.push(`${p.id}.expected`);
    if (editActual !== p.actualTotalDays) viewDiffs.push(`${p.id}.actual`);
  }
  add("edit page values == detail page / export values for every Project", viewDiffs.length === 0, viewDiffs.slice(0, 10).join("; "));

  const fin = summarize(replan).financial;
  const predicted = (run.summary as any)?.financial;
  add("current financial totals == the run's predicted 'after' totals", !!predicted && fin.estimatedCostBeforeEUR === predicted.estimatedCostAfterEUR && fin.actualCostBeforeEUR === predicted.actualCostAfterEUR, `estimated ${fin.estimatedCostBeforeEUR} (predicted ${predicted?.estimatedCostAfterEUR}), actual ${fin.actualCostBeforeEUR} (predicted ${predicted?.actualCostAfterEUR})`);
  return { ok: results.every((r) => r.ok), results };
}

async function main() {
  const cmd = process.argv[2] ?? "report";
  const prisma = new PrismaClient();
  try {
    const includeFillMissing = !flag("--exclude-fill-missing");
    if (cmd === "report") {
      const data = await loadPlan(prisma, { includeFillMissing });
      const summary = summarize(data);
      console.log(JSON.stringify(summary, null, 2));
      const out = arg("--out");
      if (out) {
        await fs.mkdir(out, { recursive: true });
        await fs.writeFile(path.join(out, "working-days-impact.json"), JSON.stringify(summary, null, 2));
        await fs.writeFile(path.join(out, "working-days-impact-records.csv"), toCsv(data.plan));
        console.error(`Wrote ${path.join(out, "working-days-impact.json")} and working-days-impact-records.csv`);
      }
    } else if (cmd === "apply") {
      if (arg("--confirm") !== APPLY_PHRASE) throw new Error(`Refusing to write: pass --confirm "${APPLY_PHRASE}".`);
      const { runId, summary } = await apply(prisma, { includeFillMissing });
      console.log(JSON.stringify({ runId, fieldsWritten: runId ? summary.fieldsToWrite : 0, summary }, null, 2));
      if (!runId) console.error("Nothing to do — every eligible duration is already in working days.");
    } else if (cmd === "rollback") {
      const runId = arg("--run");
      if (!runId) throw new Error("Pass --run <runId>.");
      if (arg("--confirm") !== ROLLBACK_PHRASE) throw new Error(`Refusing to write: pass --confirm "${ROLLBACK_PHRASE}".`);
      console.log(JSON.stringify(await rollback(prisma, runId, { skipConflicts: flag("--skip-conflicts") }), null, 2));
    } else if (cmd === "snapshot") {
      const out = arg("--out");
      if (!out) throw new Error("Pass --out <file.json>.");
      const snap = await takeSnapshot(prisma);
      await fs.writeFile(out, JSON.stringify(snap));
      console.log(JSON.stringify({ out, projects: snap.projects.length, activities: snap.activities.length, takenAt: snap.takenAt }));
    } else if (cmd === "validate") {
      const beforeFile = arg("--before");
      const runId = arg("--run");
      if (!beforeFile || !runId) throw new Error("Pass --before <file.json> --run <runId>.");
      const result = await validate(prisma, JSON.parse(await fs.readFile(beforeFile, "utf8")), runId);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } else if (cmd === "status") {
      const runs = await prisma.durationBackfillRun.findMany({ orderBy: { appliedAt: "asc" }, include: { _count: { select: { changes: true } } } });
      console.log(JSON.stringify(runs.map((r) => ({ id: r.id, kind: r.kind, status: r.status, appliedAt: r.appliedAt, rolledBackAt: r.rolledBackAt, changes: r._count.changes })), null, 2));
    } else throw new Error(`Unknown command "${cmd}".`);
  } finally {
    await prisma.$disconnect();
  }
}

// Runs when invoked directly — as TypeScript (npx tsx scripts/working-days-backfill/cli.ts …)
// or as the production bundle (node dist/ops/working-days-backfill.cjs …, built by
// `npm run ops:build`); never when imported by the verification scripts.
if (process.argv[1] && /working-days-backfill(?:[\\/]cli\.ts|\.cjs)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
