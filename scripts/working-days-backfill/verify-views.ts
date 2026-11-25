/**
 * READ-ONLY post-backfill view verification through the REAL route handlers
 * (mocked session = an existing ADMIN): for every Project touched by a run
 * (directly, or through one of its Activities), GET /api/projects/[id]
 * (what the edit page loads) and GET /api/projects/[id]/export (the Excel
 * workbook) must show exactly the stored durations, and per-Activity costs
 * and Project rollups must equal the canonical computeProjectFinancials
 * over the stored rate snapshots × stored working days.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/working-days-backfill/verify-views.ts --run <runId> [--admin-email admin@kinsen.gr]
 */
import { mock } from "node:test";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { computeProjectFinancials, computeActivityFinancials } from "@/lib/services/project-financials-service";

let currentSession: { user: { id: string; role: Role; customRoleId: string | null } } | null = null;
mock.module("@/lib/auth", { namedExports: { auth: async () => currentSession, handlers: {}, signIn: async () => {}, signOut: async () => {} } });

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; } else { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : typeof v === "object" && v !== null && "result" in (v as any) ? Number((v as any).result) : Number(v));

async function main() {
  const runId = arg("--run");
  if (!runId) throw new Error("Pass --run <runId>.");
  const admin = await prisma.user.findFirstOrThrow({ where: { email: arg("--admin-email") ?? "admin@kinsen.gr", role: Role.ADMIN } });
  currentSession = { user: { id: admin.id, role: Role.ADMIN, customRoleId: null } };
  const { GET: projectGET } = await import("@/app/api/projects/[id]/route");
  const { GET: exportGET } = await import("@/app/api/projects/[id]/export/route");
  const { NextRequest } = await import("next/server");

  const changes = await prisma.durationBackfillChange.findMany({ where: { runId } });
  const activityIds = changes.filter((c) => c.entity === "ProjectActivity").map((c) => c.recordId);
  const viaActivities = await prisma.projectActivity.findMany({ where: { id: { in: activityIds } }, select: { projectId: true } });
  const projectIds = Array.from(new Set([...changes.filter((c) => c.entity === "Project").map((c) => c.recordId), ...viaActivities.map((a) => a.projectId).filter((x): x is string => !!x)]));
  const standalone = viaActivities.filter((a) => !a.projectId).length;
  console.log(`Run ${runId}: ${changes.length} changed fields; checking ${projectIds.length} affected Projects (${standalone} standalone Activities have no Project view).`);

  for (const id of projectIds) {
    const db = await prisma.project.findUniqueOrThrow({ where: { id }, include: { activities: { select: { id: true, title: true, taskSubTypeCost: true, expectedDays: true, actualDays: true } } } });
    const roll = computeProjectFinancials(db.activities);
    const api = await (await projectGET(new NextRequest(`http://localhost/api/projects/${id}`), { params: Promise.resolve({ id }) })).json();
    check(`${id} API (edit page) Expected Total Initial Days == stored`, api.expectedTotalInitialDays === db.expectedTotalInitialDays);
    check(`${id} API Actual Total Days == stored`, api.actualTotalDays === db.actualTotalDays);
    check(`${id} API rollup == canonical (estimated ${roll.estimatedCost})`, api.estimatedCost === roll.estimatedCost.toString(), api.estimatedCost);
    check(`${id} API rollup == canonical (actual ${roll.actualCost})`, api.actualCost === roll.actualCost.toString(), api.actualCost);

    const res = await exportGET(new NextRequest(`http://localhost/api/projects/${id}/export`), { params: Promise.resolve({ id }) });
    check(`${id} export -> 200`, res.status === 200, String(res.status));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
    const details = wb.getWorksheet("Project Details")!;
    const kv = new Map<string, unknown>();
    details.eachRow((row, i) => { if (i > 1) kv.set(String(row.getCell(1).value), row.getCell(2).value); });
    check(`${id} Excel "Expected Total Days" == stored`, (kv.has("Expected Total Days") ? num(kv.get("Expected Total Days")) : null) === db.expectedTotalInitialDays);
    check(`${id} Excel "Actual Total Days" == stored`, (kv.has("Actual Total Days") ? num(kv.get("Actual Total Days")) : null) === db.actualTotalDays);

    const fin = wb.getWorksheet("Financials")!;
    const header = (fin.getRow(1).values as unknown[]).map(String);
    const col = (h: string) => header.indexOf(h);
    let totalEst: number | null = null, totalAct: number | null = null;
    const rows: { title: string; ed: number | null; ad: number | null; est: number | null; act: number | null }[] = [];
    fin.eachRow((row, i) => {
      if (i === 1) return;
      const title = String(row.getCell(col("Activity")).value);
      if (title === "TOTAL") { totalEst = num(row.getCell(col("Estimated Cost (EUR)")).value); totalAct = num(row.getCell(col("Actual Cost (EUR)")).value); return; }
      rows.push({ title, ed: num(row.getCell(col("Expected Days")).value), ad: num(row.getCell(col("Actual Days")).value), est: num(row.getCell(col("Estimated Cost (EUR)")).value), act: num(row.getCell(col("Actual Cost (EUR)")).value) });
    });
    check(`${id} Excel has one Financials row per Activity`, rows.length === db.activities.length, `${rows.length} vs ${db.activities.length}`);
    for (const a of db.activities) {
      const r = rows.find((x) => x.title === a.title);
      const f = computeActivityFinancials(a);
      check(`${id}/${a.id} Excel days == stored`, !!r && r.ed === a.expectedDays && r.ad === a.actualDays, JSON.stringify(r));
      check(`${id}/${a.id} Excel costs == rate snapshot × stored working days`, !!r && r.est === Number(f.estimatedCost) && r.act === Number(f.actualCost), JSON.stringify(r));
    }
    check(`${id} Excel TOTAL == canonical rollup`, totalEst === Number(roll.estimatedCost) && totalAct === Number(roll.actualCost), `${totalEst}/${totalAct} vs ${roll.estimatedCost}/${roll.actualCost}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("verify-views crashed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
