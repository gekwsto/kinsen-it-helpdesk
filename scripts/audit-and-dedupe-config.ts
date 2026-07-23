/**
 * Audits and safely deduplicates department-scoped config records
 * (TicketCategory/TicketPriority/TicketStatus/TicketCancelReason) that were
 * accidentally duplicated by a one-time seed bug (see PR/commit history —
 * `prisma/seed.ts` was rewritten to upsert by a fixed id instead of by name,
 * which on an already-seeded database created a brand-new row alongside the
 * pre-existing one instead of matching it). This script finds any
 * (departmentId, normalized name) group with more than one row, picks a
 * canonical record (the one with the most real ticket references — ties
 * broken by oldest `createdAt`), remaps every Ticket/SlaPolicy reference
 * from the losers to the canonical row, merges a few safety flags onto the
 * canonical row, and only then removes the now fully-unreferenced losers.
 *
 * Always computes a fresh plan at run time (never reads a cached report),
 * so `--apply` never acts on stale dry-run output.
 *
 * Usage:
 *   npx tsx scripts/audit-and-dedupe-config.ts            (dry-run, default)
 *   npx tsx scripts/audit-and-dedupe-config.ts --dry-run
 *   npx tsx scripts/audit-and-dedupe-config.ts --apply
 *
 * Required before applying the partial-unique-index migration
 * (prisma/migrations/*_add_global_name_uniqueness) — that migration's own
 * guard will refuse to run while duplicates remain, so run this with
 * --apply first if it does.
 */
import { prisma } from "@/lib/prisma";

interface EntityConfig {
  label: string;
  table: string;
  model: "ticketCategory" | "ticketPriority" | "ticketStatus" | "ticketCancelReason";
  ticketFk: "categoryId" | "priorityId" | "statusId" | "cancelReasonId";
  /** Boolean fields where "true wins" if ANY duplicate has it set. */
  mergeBooleanFields: string[];
  /** Fields where the canonical's value is kept unless it's empty/null and a loser has a real value. */
  preserveIfEmptyFields: string[];
}

const ENTITY_CONFIGS: EntityConfig[] = [
  {
    label: "TicketCategory",
    table: "TicketCategory",
    model: "ticketCategory",
    ticketFk: "categoryId",
    mergeBooleanFields: ["isActive"],
    preserveIfEmptyFields: ["description", "color"],
  },
  {
    label: "TicketPriority",
    table: "TicketPriority",
    model: "ticketPriority",
    ticketFk: "priorityId",
    mergeBooleanFields: ["isActive"],
    preserveIfEmptyFields: ["color"],
  },
  {
    label: "TicketStatus",
    table: "TicketStatus",
    model: "ticketStatus",
    ticketFk: "statusId",
    mergeBooleanFields: ["isActive", "isDefault", "isClosed"],
    preserveIfEmptyFields: ["color"],
  },
  {
    label: "TicketCancelReason",
    table: "TicketCancelReason",
    model: "ticketCancelReason",
    ticketFk: "cancelReasonId",
    mergeBooleanFields: ["isActive"],
    preserveIfEmptyFields: ["description"],
  },
];

export interface SlaPolicyAction {
  action: "adopt" | "discard";
  loserPriorityId: string;
}

export interface DedupePlanItem {
  entity: string;
  departmentId: string | null;
  normalizedName: string;
  canonicalId: string;
  loserIds: string[];
  /** How many Ticket rows will be repointed from a loser to the canonical. */
  ticketRemapCount: number;
  /** Fields to update on the canonical row before the losers are deleted. */
  mergedFields: Record<string, unknown>;
  /** TicketPriority only — how each loser's SlaPolicy (if any) is handled. */
  slaPolicyActions: SlaPolicyAction[];
}

async function findDuplicateGroups(table: string): Promise<{ departmentId: string | null; normalizedName: string; ids: string[] }[]> {
  const rows: any[] = await prisma.$queryRawUnsafe(`
    SELECT "departmentId", lower(btrim(name)) AS norm_name, array_agg(id ORDER BY "createdAt" ASC) AS ids
    FROM "${table}"
    GROUP BY "departmentId", lower(btrim(name))
    HAVING count(*) > 1
  `);
  return rows.map((r) => ({ departmentId: r.departmentId, normalizedName: r.norm_name, ids: r.ids as string[] }));
}

/**
 * Computes a fresh dedup plan for one entity. Pure read — makes no writes.
 * Safe to call repeatedly (e.g. once for `--dry-run` printing, and again
 * immediately before `--apply` actually writes, so nothing acts on stale data).
 */
export async function computeDedupePlan(config: EntityConfig): Promise<DedupePlanItem[]> {
  const groups = await findDuplicateGroups(config.table);
  const modelClient = (prisma as any)[config.model];
  const plan: DedupePlanItem[] = [];

  for (const group of groups) {
    const rows: any[] = await modelClient.findMany({ where: { id: { in: group.ids } } });

    const withCounts = await Promise.all(
      rows.map(async (row) => ({
        row,
        ticketCount: await prisma.ticket.count({ where: { [config.ticketFk]: row.id } as any }),
      }))
    );

    // Most-referenced wins outright; ties broken by oldest createdAt.
    withCounts.sort((a, b) => {
      if (b.ticketCount !== a.ticketCount) return b.ticketCount - a.ticketCount;
      return new Date(a.row.createdAt).getTime() - new Date(b.row.createdAt).getTime();
    });

    const canonical = withCounts[0].row;
    const losers = withCounts.slice(1).map((w) => w.row);

    const mergedFields: Record<string, unknown> = {};
    for (const field of config.mergeBooleanFields) {
      const shouldBeTrue = Boolean(canonical[field]) || losers.some((l) => Boolean(l[field]));
      if (shouldBeTrue !== Boolean(canonical[field])) mergedFields[field] = shouldBeTrue;
    }
    for (const field of config.preserveIfEmptyFields) {
      const canonicalEmpty = canonical[field] == null || canonical[field] === "";
      if (canonicalEmpty) {
        const better = losers.find((l) => l[field] != null && l[field] !== "");
        if (better) mergedFields[field] = better[field];
      }
    }

    let ticketRemapCount = 0;
    for (const loser of losers) {
      ticketRemapCount += await prisma.ticket.count({ where: { [config.ticketFk]: loser.id } as any });
    }

    const slaPolicyActions: SlaPolicyAction[] = [];
    if (config.model === "ticketPriority") {
      const canonicalPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: canonical.id } });
      for (const loser of losers) {
        const loserPolicy = await prisma.slaPolicy.findUnique({ where: { priorityId: loser.id } });
        if (loserPolicy) {
          slaPolicyActions.push({ action: canonicalPolicy ? "discard" : "adopt", loserPriorityId: loser.id });
        }
      }
    }

    plan.push({
      entity: config.label,
      departmentId: group.departmentId,
      normalizedName: group.normalizedName,
      canonicalId: canonical.id,
      loserIds: losers.map((l) => l.id),
      ticketRemapCount,
      mergedFields,
      slaPolicyActions,
    });
  }

  return plan;
}

/**
 * Applies a previously (or freshly) computed plan for one entity. Each
 * duplicate group is handled in its own transaction: remap Ticket
 * references away from the losers, resolve SlaPolicy ownership, merge
 * safety flags onto the canonical row, then delete the now-unreferenced
 * losers — in that order, so nothing is ever deleted while still referenced.
 */
export async function applyDedupePlan(config: EntityConfig, plan: DedupePlanItem[]): Promise<void> {
  const modelClient = (prisma as any)[config.model];

  for (const item of plan) {
    await prisma.$transaction(async (tx) => {
      const txModel = (tx as any)[config.model];

      if (item.loserIds.length > 0) {
        await (tx as any).ticket.updateMany({
          where: { [config.ticketFk]: { in: item.loserIds } },
          data: { [config.ticketFk]: item.canonicalId },
        });
      }

      for (const slaAction of item.slaPolicyActions) {
        if (slaAction.action === "adopt") {
          await tx.slaPolicy.update({
            where: { priorityId: slaAction.loserPriorityId },
            data: { priorityId: item.canonicalId },
          });
        } else {
          console.warn(
            `  ! Discarding SlaPolicy for loser priority ${slaAction.loserPriorityId} — canonical ${item.canonicalId} already has one.`
          );
          await tx.slaPolicy.delete({ where: { priorityId: slaAction.loserPriorityId } });
        }
      }

      if (Object.keys(item.mergedFields).length > 0) {
        await txModel.update({ where: { id: item.canonicalId }, data: item.mergedFields });
      }

      if (item.loserIds.length > 0) {
        await txModel.deleteMany({ where: { id: { in: item.loserIds } } });
      }
    });
  }
}

function printPlan(config: EntityConfig, plan: DedupePlanItem[]) {
  if (plan.length === 0) {
    console.log(`  (no duplicates)`);
    return;
  }
  for (const item of plan) {
    console.log(
      `  [${item.departmentId ?? "global"}] "${item.normalizedName}": keep ${item.canonicalId}, remove ${item.loserIds.length} duplicate(s) [${item.loserIds.join(", ")}], remap ${item.ticketRemapCount} ticket(s)` +
        (Object.keys(item.mergedFields).length > 0 ? `, merge fields ${JSON.stringify(item.mergedFields)}` : "") +
        (item.slaPolicyActions.length > 0 ? `, SLA actions: ${JSON.stringify(item.slaPolicyActions)}` : "")
    );
  }
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

  let totalGroups = 0;
  for (const config of ENTITY_CONFIGS) {
    console.log(`=== ${config.label} ===`);
    const plan = await computeDedupePlan(config);
    totalGroups += plan.length;
    printPlan(config, plan);
    if (apply && plan.length > 0) {
      await applyDedupePlan(config, plan);
      console.log(`  -> applied.`);
    }
    console.log("");
  }

  if (!apply && totalGroups > 0) {
    console.log(`${totalGroups} duplicate group(s) found. Re-run with --apply to clean them up.`);
  } else if (totalGroups === 0) {
    console.log("No duplicates found — nothing to do.");
  } else {
    console.log(`Done. ${totalGroups} duplicate group(s) resolved.`);
  }

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
