/**
 * One-time data-integrity repair: fixes tickets whose statusId/priorityId/
 * categoryId point at a TicketStatus/TicketPriority/TicketCategory row
 * belonging to a DIFFERENT department than the ticket's own `departmentId`.
 *
 * Background: prisma/seed.ts resolved openStatus/highPri/hardwareCat/etc.
 * ONCE, scoped to dept-it, then reused those same dept-it-scoped variables
 * for several tickets explicitly seeded into Finance/HR/Sales/Operations —
 * producing exactly this corruption. The bug this caused: a workspace's
 * Status filter dropdown scopes its options to the ACTIVE department's own
 * TicketStatus rows (`statusId IN (Finance's own row ids)`), which can
 * never match a ticket whose statusId actually points at a DIFFERENT
 * department's row — the ticket renders a correct-looking status badge
 * (the row's `name` is real, e.g. "Open") but silently vanishes from any
 * filtered view for that department. See the seed.ts fix (which stops new
 * occurrences) and lib/services/department-scope-service.ts's
 * validateTicketConfigOwnership (which now rejects this on every relevant
 * write path) for the rest of the fix — this script only repairs EXISTING
 * rows.
 *
 * Deterministic, name-based remap ONLY (never invented/guessed): for each
 * mismatched ticket, look up an ACTIVE row with the exact same `name` in
 * the ticket's OWN department (every department in this app is seeded with
 * the same starter Status/Priority/Category name set, so this is expected
 * to resolve cleanly). A ticket whose current department has no
 * same-named equivalent is reported as UNRESOLVED and left completely
 * untouched — never a fallback guess, never a random/default substitution.
 *
 * Legacy (departmentId: null) tickets are correctly scoped to the
 * fallback legacy department already (see the Prisma query below, which
 * only ever looks at `departmentId: { not: null }` tickets) — see
 * buildTicketListWhere's own legacy-department fallback semantics; this
 * script does not touch them.
 *
 * Idempotent: safe to re-run — after a successful --apply, the same query
 * that found the mismatches returns zero rows.
 *
 * No ticket is deleted, no history/messages/attachments are touched — only
 * the 3 FK columns (statusId/priorityId/categoryId) are updated, and only
 * on the exact rows found broken.
 *
 * Usage:
 *   npx tsx scripts/repair-ticket-config-department-mismatch.ts            (dry-run, default — reports only)
 *   npx tsx scripts/repair-ticket-config-department-mismatch.ts --apply
 */
import { prisma } from "@/lib/prisma";
import { findEquivalentDepartmentConfig } from "@/lib/services/department-scope-service";

const APPLY = process.argv.includes("--apply");

export interface FieldMismatch {
  field: "statusId" | "priorityId" | "categoryId";
  currentId: string;
  currentName: string;
  currentRowDepartmentId: string;
  resolution: { ok: true; newId: string } | { ok: false; reason: string };
}

// The exact ticket shape both this script and callers (tests) need to detect
// and resolve mismatches — kept as a standalone type so tests can build
// fixtures of this shape directly, without depending on Prisma's generated
// payload types.
export interface TicketConfigOwnershipCheckInput {
  departmentId: string;
  status: { id: string; name: string; departmentId: string } | null;
  priority: { id: string; name: string; departmentId: string } | null;
  category: { id: string; name: string; departmentId: string } | null;
}

// Re-exported for backward compatibility with existing callers of this
// script's own findEquivalent — the actual lookup now lives in
// department-scope-service.ts (findEquivalentDepartmentConfig) so the
// department-transfer route (PATCH /api/tickets/[id]/department) and this
// one-time repair script share exactly the same remap logic.
export const findEquivalent = findEquivalentDepartmentConfig;

// Pure detection — no DB access, no resolution lookups. Returns the fields
// (if any) whose config row belongs to a different department than the
// ticket itself. Used by both the repair script and the integrity-audit /
// legacy-mismatch regression tests, so "what counts as a mismatch" is
// defined in exactly one place.
export function detectTicketConfigMismatches(
  ticket: TicketConfigOwnershipCheckInput
): Array<{ field: FieldMismatch["field"]; row: { id: string; name: string; departmentId: string } }> {
  const mismatches: Array<{ field: FieldMismatch["field"]; row: { id: string; name: string; departmentId: string } }> = [];
  if (ticket.status && ticket.status.departmentId !== ticket.departmentId) {
    mismatches.push({ field: "statusId", row: ticket.status });
  }
  if (ticket.priority && ticket.priority.departmentId !== ticket.departmentId) {
    mismatches.push({ field: "priorityId", row: ticket.priority });
  }
  if (ticket.category && ticket.category.departmentId !== ticket.departmentId) {
    mismatches.push({ field: "categoryId", row: ticket.category });
  }
  return mismatches;
}

const MODEL_BY_FIELD = {
  statusId: "ticketStatus",
  priorityId: "ticketPriority",
  categoryId: "ticketCategory",
} as const;

const REASON_LABEL = {
  statusId: "status",
  priorityId: "priority",
  categoryId: "category",
} as const;

// Detects AND resolves (via findEquivalent, i.e. real DB lookups) — the same
// logic main() below applies to every ticket, extracted so tests can call it
// directly against isolated fixtures instead of reimplementing it.
export async function resolveTicketConfigMismatches(ticket: TicketConfigOwnershipCheckInput): Promise<FieldMismatch[]> {
  const detected = detectTicketConfigMismatches(ticket);
  const resolved: FieldMismatch[] = [];
  for (const { field, row } of detected) {
    const equivalent = await findEquivalent(MODEL_BY_FIELD[field], ticket.departmentId, row.name);
    resolved.push({
      field,
      currentId: row.id,
      currentName: row.name,
      currentRowDepartmentId: row.departmentId,
      resolution: equivalent
        ? { ok: true, newId: equivalent.id }
        : { ok: false, reason: `No active "${row.name}" ${REASON_LABEL[field]} exists in this ticket's own department.` },
    });
  }
  return resolved;
}

async function main() {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log("No reachable DATABASE_URL — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  console.log(`\n=== Ticket config-ownership integrity repair (${APPLY ? "APPLY" : "DRY RUN"}) ===\n`);

  const tickets = await prisma.ticket.findMany({
    where: { departmentId: { not: null } },
    select: {
      id: true,
      ticketNumber: true,
      departmentId: true,
      statusId: true,
      priorityId: true,
      categoryId: true,
      status: { select: { id: true, name: true, departmentId: true } },
      priority: { select: { id: true, name: true, departmentId: true } },
      category: { select: { id: true, name: true, departmentId: true } },
    },
    orderBy: { ticketNumber: "asc" },
  });

  let resolvedCount = 0;
  let unresolvedCount = 0;
  let cleanCount = 0;

  for (const ticket of tickets) {
    const departmentId = ticket.departmentId!;
    const mismatches = await resolveTicketConfigMismatches({
      departmentId,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
    });

    if (mismatches.length === 0) {
      cleanCount++;
      continue;
    }

    console.log(`KIN-${ticket.ticketNumber} (${ticket.id}) — department ${departmentId}:`);
    const updateData: Record<string, string> = {};
    let ticketHasUnresolved = false;
    for (const m of mismatches) {
      if (m.resolution.ok) {
        console.log(`  ${m.field}: ${m.currentName} [${m.currentId}] (dept ${m.currentRowDepartmentId}) -> ${m.currentName} [${m.resolution.newId}] (this ticket's own department)`);
        updateData[m.field] = m.resolution.newId;
      } else {
        console.log(`  ${m.field}: ${m.currentName} [${m.currentId}] (dept ${m.currentRowDepartmentId}) -> UNRESOLVED: ${m.resolution.reason}`);
        ticketHasUnresolved = true;
      }
    }

    if (ticketHasUnresolved) {
      unresolvedCount++;
      console.log(`  -> SKIPPED (at least one field has no deterministic equivalent — never guessing).\n`);
      continue;
    }

    resolvedCount++;
    if (APPLY) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: updateData });
      console.log(`  -> APPLIED.\n`);
    } else {
      console.log(`  -> would be applied with --apply.\n`);
    }
  }

  console.log("=== Summary ===");
  console.log(`Tickets scanned (non-legacy, departmentId set): ${tickets.length}`);
  console.log(`Already correct: ${cleanCount}`);
  console.log(`${APPLY ? "Repaired" : "Would repair"}: ${resolvedCount}`);
  console.log(`Unresolved (left untouched — no equivalent config in the ticket's own department): ${unresolvedCount}`);
  if (!APPLY && resolvedCount > 0) {
    console.log("\nThis was a DRY RUN — no data was changed. Re-run with --apply to perform the updates above.");
  }

  await prisma.$disconnect();
  process.exit(unresolvedCount > 0 ? 1 : 0);
}

// Guarded so other scripts (e.g. test-ticket-config-ownership-integrity.ts)
// can import findEquivalent/detectTicketConfigMismatches/
// resolveTicketConfigMismatches from this module without triggering a full
// tenant-wide repair run (and its process.exit()) as an import side effect.
import { fileURLToPath } from "url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Repair script crashed:", err);
    process.exit(1);
  });
}
