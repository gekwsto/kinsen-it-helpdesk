/**
 * CLI entry point for the User/Department/Member Phase 3 reconciliation.
 * All logic lives in lib/services/department-membership-reconciliation-service.ts
 * (see its header for the full categorization/safety rules) — this script
 * is just the dry-run/apply/report wiring, kept separate so the logic is
 * importable by tests without triggering a CLI run as an import side effect.
 *
 * Usage:
 *   npx tsx scripts/reconcile-user-department-membership.ts             (dry-run — read-only report)
 *   npx tsx scripts/reconcile-user-department-membership.ts --apply     (writes the deterministic fixes)
 */
import { prisma } from "@/lib/prisma";
import { buildReconciliationPlan, printReconciliationPlanSummary, applyReconciliationPlan } from "@/lib/services/department-membership-reconciliation-service";
import { writeFileSync } from "node:fs";

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  const plan = await buildReconciliationPlan();
  printReconciliationPlanSummary(plan);

  console.log("\n=== Unresolved conflicts (never auto-fixed) ===\n");
  for (const item of plan.items.filter((i) => i.category === "F_conflict")) {
    console.log(`  - ${item.email} (${item.userId}): ${item.detail}`);
  }

  const scratchPath = "/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/156a97d4-1f71-4afb-8ebb-333824708364/scratchpad/membership-reconciliation-plan.json";
  try {
    writeFileSync(scratchPath, JSON.stringify(plan, null, 2));
    console.log(`\nFull plan written to ${scratchPath}`);
  } catch {
    // Scratch dir write is best-effort only — never fatal to the reconciliation itself.
  }

  if (!apply) {
    console.log("\nDRY RUN — no changes made. Re-run with --apply to write the deterministic fixes.\n");
    await prisma.$disconnect();
    return;
  }

  console.log("\n=== APPLYING deterministic fixes ===\n");
  const result = await applyReconciliationPlan(plan);
  console.log(`\nFixed: ${result.fixed}`);
  console.log(`Errors: ${result.errors}`);
  if (result.errorDetails.length > 0) {
    console.log("Error details:");
    for (const e of result.errorDetails) console.log(`  - ${e.email}: ${e.reason}`);
  }

  await prisma.$disconnect();
}

main();
