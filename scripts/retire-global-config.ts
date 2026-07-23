/**
 * One-time data migration: retires the "global default" (departmentId: null)
 * concept for TicketCategory/TicketPriority/TicketStatus. Cancel Reasons are
 * untouched — global cancel reasons are staying.
 *
 * Background: prisma/seed.ts's category-seeding block was rewritten (commit
 * ce62bb3) from a global upsert (`where: { name }`) to a dept-it-scoped one
 * (`where: { departmentId_name: {departmentId:"dept-it", name} }`). On an
 * already-seeded database, that new key never matched the pre-existing
 * global rows (which carry real Ticket history), so it silently created a
 * fresh, empty dept-it row alongside each real global one instead of
 * updating it — the duplicate "IT Department (0 tickets)" / "Global default
 * (N tickets)" rows visible in /admin/categories today. Priorities/Statuses
 * were never touched by that bug and have no such duplicates.
 *
 * What this script does, per entity:
 *   1. For each global (departmentId: null) row, look for an existing
 *      dept-it row with the same normalized name.
 *        - If found (the categories case): reassign any Ticket FK pointing
 *          at that dept-it placeholder to the global row (expected to be 0
 *          refs, handled safely regardless), resolve SlaPolicy ownership
 *          (priorities only), delete the placeholder, then reparent the
 *          global row to dept-it. The global row's id never changes, so
 *          every real historical Ticket reference keeps resolving exactly
 *          as before.
 *        - If not found (the priorities/statuses case today): just
 *          reparent the global row to dept-it directly.
 *   2. For every OTHER department (dept-hr, dept-finance, dept-sales,
 *      dept-operations): copy dept-it's now-canonical categories/
 *      priorities/statuses as fresh, independent rows under that
 *      department (new ids, no ticket refs) — an editable starting point,
 *      not a live/shared default.
 *
 * Idempotent: safe to re-run. After the first successful --apply there are
 * no more departmentId:null rows left to process, and step 2 only creates
 * rows that don't already exist (by (departmentId, name)).
 *
 * Usage:
 *   npx tsx scripts/retire-global-config.ts            (dry-run, default)
 *   npx tsx scripts/retire-global-config.ts --apply
 */
import { prisma } from "@/lib/prisma";
import { ensureCategoryForDepartment, ensurePriorityForDepartment, ensureStatusForDepartment } from "@/lib/services/config-starter-data";

const IT_DEPARTMENT_ID = "dept-it";
const OTHER_DEPARTMENT_IDS = ["dept-hr", "dept-finance", "dept-sales", "dept-operations"];

const normalize = (name: string) => name.trim().toLowerCase();

interface RetireConfig {
  label: string;
  model: "ticketCategory" | "ticketPriority" | "ticketStatus";
  ticketFk: "categoryId" | "priorityId" | "statusId";
}

const CONFIGS: RetireConfig[] = [
  { label: "TicketCategory", model: "ticketCategory", ticketFk: "categoryId" },
  { label: "TicketPriority", model: "ticketPriority", ticketFk: "priorityId" },
  { label: "TicketStatus", model: "ticketStatus", ticketFk: "statusId" },
];

async function mergeOrReparentGlobalRows(config: RetireConfig, apply: boolean) {
  const modelClient = (prisma as any)[config.model];
  const globalRows: any[] = await modelClient.findMany({ where: { departmentId: null } });
  const deptItRows: any[] = await modelClient.findMany({ where: { departmentId: IT_DEPARTMENT_ID } });
  const deptItByName = new Map(deptItRows.map((r) => [normalize(r.name), r]));

  let merged = 0;
  let reparented = 0;

  for (const globalRow of globalRows) {
    const collision = deptItByName.get(normalize(globalRow.name));

    if (collision) {
      const ticketCount = await prisma.ticket.count({ where: { [config.ticketFk]: collision.id } as any });
      console.log(
        `  [${config.label}] merge: "${globalRow.name}" — global ${globalRow.id} (canonical, kept) <- dept-it placeholder ${collision.id} (${ticketCount} ticket(s) to remap, then deleted)`
      );
      if (apply) {
        await prisma.$transaction(async (tx) => {
          if (ticketCount > 0) {
            await (tx as any).ticket.updateMany({
              where: { [config.ticketFk]: collision.id },
              data: { [config.ticketFk]: globalRow.id },
            });
          }
          if (config.model === "ticketPriority") {
            const [canonicalPolicy, loserPolicy] = await Promise.all([
              tx.slaPolicy.findUnique({ where: { priorityId: globalRow.id } }),
              tx.slaPolicy.findUnique({ where: { priorityId: collision.id } }),
            ]);
            if (loserPolicy) {
              if (canonicalPolicy) {
                await tx.slaPolicy.delete({ where: { priorityId: collision.id } });
              } else {
                await tx.slaPolicy.update({ where: { priorityId: collision.id }, data: { priorityId: globalRow.id } });
              }
            }
          }
          await (tx as any)[config.model].delete({ where: { id: collision.id } });
          await (tx as any)[config.model].update({ where: { id: globalRow.id }, data: { departmentId: IT_DEPARTMENT_ID } });
        });
      }
      merged++;
    } else {
      console.log(`  [${config.label}] reparent: "${globalRow.name}" (${globalRow.id}) -> ${IT_DEPARTMENT_ID}`);
      if (apply) {
        await modelClient.update({ where: { id: globalRow.id }, data: { departmentId: IT_DEPARTMENT_ID } });
      }
      reparented++;
    }
  }

  return { merged, reparented };
}

async function copyItSetToOtherDepartments(apply: boolean) {
  const [categories, priorities, statuses] = await Promise.all([
    prisma.ticketCategory.findMany({ where: { departmentId: IT_DEPARTMENT_ID } }),
    prisma.ticketPriority.findMany({ where: { departmentId: IT_DEPARTMENT_ID } }),
    prisma.ticketStatus.findMany({ where: { departmentId: IT_DEPARTMENT_ID } }),
  ]);

  const counts = { categories: 0, priorities: 0, statuses: 0 };

  for (const departmentId of OTHER_DEPARTMENT_IDS) {
    const department = await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true } });
    if (!department) {
      console.log(`  ! Department ${departmentId} not found — skipping (seed.ts may not have run yet).`);
      continue;
    }

    for (const c of categories) {
      const existing = await prisma.ticketCategory.findFirst({ where: { departmentId, name: c.name } });
      if (existing) continue;
      console.log(`  [copy] Category "${c.name}" -> ${departmentId}`);
      if (apply) {
        await ensureCategoryForDepartment(prisma, departmentId, { name: c.name, description: c.description, color: c.color });
      }
      counts.categories++;
    }
    for (const p of priorities) {
      const existing = await prisma.ticketPriority.findFirst({ where: { departmentId, name: p.name } });
      if (existing) continue;
      console.log(`  [copy] Priority "${p.name}" -> ${departmentId}`);
      if (apply) {
        await ensurePriorityForDepartment(prisma, departmentId, { name: p.name, level: p.level, color: p.color });
      }
      counts.priorities++;
    }
    for (const s of statuses) {
      const existing = await prisma.ticketStatus.findFirst({ where: { departmentId, name: s.name } });
      if (existing) continue;
      console.log(`  [copy] Status "${s.name}" -> ${departmentId}`);
      if (apply) {
        await ensureStatusForDepartment(prisma, departmentId, {
          name: s.name,
          color: s.color,
          isDefault: s.isDefault,
          isClosed: s.isClosed,
          order: s.order,
        });
      }
      counts.statuses++;
    }
  }

  return counts;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`Running in ${apply ? "APPLY" : "DRY-RUN"} mode.\n`);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  const itDept = await prisma.department.findUnique({ where: { id: IT_DEPARTMENT_ID } });
  if (!itDept) {
    console.log(`Department "${IT_DEPARTMENT_ID}" not found — run \`npm run db:seed\` first. Aborting.`);
    process.exit(1);
  }

  console.log("=== Step 1: merge/reparent global rows into IT department ===\n");
  const stepOneResults: Record<string, { merged: number; reparented: number }> = {};
  for (const config of CONFIGS) {
    stepOneResults[config.label] = await mergeOrReparentGlobalRows(config, apply);
  }

  console.log("\n=== Step 2: copy IT's set to every other department ===\n");
  const stepTwoResult = await copyItSetToOtherDepartments(apply);

  console.log("\n=== Summary ===");
  for (const config of CONFIGS) {
    const r = stepOneResults[config.label];
    console.log(`  ${config.label}: ${r.merged} merged, ${r.reparented} reparented`);
  }
  console.log(`  Copied to other departments: ${stepTwoResult.categories} categories, ${stepTwoResult.priorities} priorities, ${stepTwoResult.statuses} statuses`);

  if (!apply) {
    console.log("\nDry run only — re-run with --apply to make these changes.");
  } else {
    console.log("\nApplied.");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
