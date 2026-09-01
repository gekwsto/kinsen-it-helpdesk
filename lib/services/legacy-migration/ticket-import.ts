/**
 * Phase 5 — ticket import.
 *
 * ticket-creation-service.ts's createTicketAtomic is designed for LIVE
 * ticket creation (session user, "now" semantics, no historical
 * dates/pre-existing assignee support) — it is not reused directly here.
 * Instead this module replicates its ATOMIC invariant (one Ticket + its
 * initial TicketMessage + its initial TicketHistory "CREATED" row, in one
 * short transaction, never partially committed) with migration-appropriate
 * fields: historical createdAt/updatedAt/closedAt taken from the legacy
 * row, requesterId/assignedAgentId resolved via the durable LegacyUser map
 * (lib/services/legacy-migration/user-reconciliation.ts) — never by target
 * display name — and no notification side effects (this is historical
 * data, not a live event).
 *
 * Each ticket is its own short transaction — never one giant transaction
 * for all 580 rows (see the migration brief's explicit batching
 * requirement) — so a single bad row fails (and is ledger-recorded as
 * FAILED) without aborting or rolling back any other already-committed
 * ticket, and without leaving a shared transaction aborted while counters
 * falsely report success.
 */
import type { PrismaClient } from "@prisma/client";
import { TicketSource, TicketHistoryType, MessageDirection } from "@prisma/client";
import type { LegacyTicketRow } from "@/lib/services/legacy-migration/sql-source-client";
import { getLedgerEntry, recordLedgerSuccess, recordLedgerFailure } from "@/lib/services/legacy-migration/ledger";
import {
  resolveLegacyStatusName,
  resolveLegacyPriority,
  resolveLegacyCategoryTarget,
  resolveLegacyPlatformName,
} from "@/lib/services/legacy-migration/enum-maps";
import type { ReferenceDataMaps } from "@/lib/services/legacy-migration/reference-data";

export interface TicketImportContext {
  targetDepartmentId: string;
  usernameToUserId: Map<string, string>;
  referenceData: ReferenceDataMaps;
  /** Target User.id for the "Legacy Unknown Creator" placeholder — used ONLY for the (expected: 2) tickets with no legacy creator at all. Never "System Administrator" or any real staff account. */
  unknownCreatorUserId: string;
  dryRun: boolean;
}

export interface TicketImportOutcome {
  legacyTicketId: number;
  status: "created" | "reused" | "failed";
  targetId?: string;
  usedUnknownCreator?: boolean;
  missingAssignee?: boolean;
  error?: string;
}

function requireDate(value: Date | null | undefined, legacyTicketId: number, fieldName: string): Date {
  if (!value) {
    throw new Error(`Ticket ${legacyTicketId}: legacy ${fieldName} is missing — refusing to substitute the migration's execution time for a historical date.`);
  }
  return value;
}

export async function importOneLegacyTicket(db: PrismaClient, row: LegacyTicketRow, ctx: TicketImportContext): Promise<TicketImportOutcome> {
  const legacyKey = String(row.Id);

  const existingLedger = await getLedgerEntry(db, "TICKET", legacyKey);
  if (existingLedger?.status === "SUCCEEDED" && existingLedger.targetId) {
    return { legacyTicketId: row.Id, status: "reused", targetId: existingLedger.targetId };
  }

  try {
    const requesterUserName = row.User?.trim();
    const requesterId = requesterUserName ? ctx.usernameToUserId.get(requesterUserName) : undefined;
    let usedUnknownCreator = false;
    let finalRequesterId: string;
    if (requesterId) {
      finalRequesterId = requesterId;
    } else if (!requesterUserName) {
      // Legitimately no creator on the legacy row (expected count: 2) —
      // Ticket.requesterId is NOT NULL in the target schema, so this
      // dedicated, clearly-named, never-a-real-staff-account placeholder is
      // the explicit safe migration mechanism the brief asks for instead of
      // ever silently assigning to System Administrator.
      finalRequesterId = ctx.unknownCreatorUserId;
      usedUnknownCreator = true;
    } else {
      throw new Error(`Ticket ${row.Id}: creator UserName "${requesterUserName}" was not found among reconciled legacy users.`);
    }

    const developerUserName = row.Developer?.trim();
    const assignedAgentId = developerUserName ? ctx.usernameToUserId.get(developerUserName) ?? null : null;
    const missingAssignee = !!developerUserName && !assignedAgentId;
    if (missingAssignee) {
      throw new Error(`Ticket ${row.Id}: assignee UserName "${developerUserName}" was not found among reconciled legacy users.`);
    }

    const statusName = resolveLegacyStatusName(row.Status);
    const statusId = ctx.referenceData.statusIdByLegacyStatus.get(row.Status!);
    if (!statusId) throw new Error(`Ticket ${row.Id}: no prepared target TicketStatus for legacy Status ${row.Status} (${statusName}).`);

    const priority = resolveLegacyPriority(row.Priority);
    const priorityId = ctx.referenceData.priorityIdByLegacyPriority.get(row.Priority!);
    if (!priorityId) throw new Error(`Ticket ${row.Id}: no prepared target TicketPriority for legacy Priority ${row.Priority} (${priority.name}).`);

    const category = resolveLegacyCategoryTarget(row.Category, row.SubCategory);
    const categoryId = ctx.referenceData.categoryIdByName.get(category.name);
    if (!categoryId) throw new Error(`Ticket ${row.Id}: no prepared target TicketCategory "${category.name}".`);

    const createdAt = requireDate(row.OpenDate, row.Id, "OpenDate");
    const updatedAt = row.LastUpdatedOn ?? createdAt;
    const closedAt = row.CloseDate ?? null;

    const title = row.Title?.trim() || `Migrated legacy ticket #${row.Id}`;
    const description = row.Description?.trim() || "No description provided in the legacy system.";

    const platformName = resolveLegacyPlatformName(row.Platform);
    const createdHistoryDescription = [
      `Migrated from legacy TicketApp (Ticket #${row.Id}).`,
      platformName ? `Platform: ${platformName}.` : null,
      category.description,
    ]
      .filter(Boolean)
      .join(" ");

    if (ctx.dryRun) {
      return { legacyTicketId: row.Id, status: "created", usedUnknownCreator, missingAssignee: false };
    }

    const ticket = await db.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          title,
          description,
          source: TicketSource.WEB,
          requesterId: finalRequesterId,
          assignedAgentId,
          departmentId: ctx.targetDepartmentId,
          statusId,
          priorityId,
          categoryId,
          createdAt,
          updatedAt,
          closedAt,
        },
      });

      await tx.ticketMessage.create({
        data: {
          ticketId: created.id,
          authorId: finalRequesterId,
          body: description,
          direction: MessageDirection.INBOUND,
          isInternal: false,
          createdAt,
          updatedAt: createdAt,
        },
      });

      await tx.ticketHistory.create({
        data: {
          ticketId: created.id,
          changedById: usedUnknownCreator ? null : finalRequesterId,
          type: TicketHistoryType.CREATED,
          description: createdHistoryDescription,
          createdAt,
        },
      });

      if (row.CancelDate || row.CancelText || row.CancelledReason != null) {
        const cancelledByUserId = row.CancelledBy ? ctx.usernameToUserId.get(row.CancelledBy.trim()) ?? null : null;
        await tx.ticketHistory.create({
          data: {
            ticketId: created.id,
            changedById: cancelledByUserId,
            type: TicketHistoryType.CANCEL_REASON_SET,
            newValue: row.CancelText ?? (row.CancelledReason != null ? String(row.CancelledReason) : null),
            description: `Legacy cancellation. Reason code: ${row.CancelledReason ?? "N/A"}. Text: ${row.CancelText ?? "N/A"}.`,
            createdAt: row.CancelDate ?? updatedAt,
          },
        });
      }

      if (row.reopenDate) {
        await tx.ticketHistory.create({
          data: {
            ticketId: created.id,
            type: TicketHistoryType.REOPENED,
            description: "Legacy reopen event.",
            createdAt: row.reopenDate,
          },
        });
      }

      return created;
    });

    await recordLedgerSuccess(db, "TICKET", legacyKey, ticket.id);
    return { legacyTicketId: row.Id, status: "created", targetId: ticket.id, usedUnknownCreator, missingAssignee: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!ctx.dryRun) await recordLedgerFailure(db, "TICKET", legacyKey, message);
    return { legacyTicketId: row.Id, status: "failed", error: message };
  }
}
