/**
 * Phase 6 — comment import (dbo.CommentsTbl -> TicketMessage).
 *
 * CommentsTbl.CreatedBy is free text, not an FK — resolved ONLY by an exact
 * legacy UserName match (via the same LegacyUser map tickets use) or, when
 * that fails, an exact normalized-email match against already-reconciled
 * users. Never fuzzy-matched against a display name. An unresolved author
 * leaves TicketMessage.authorId null (the column is nullable) and is
 * reported, not guessed — this is NOT a hard failure the way a missing
 * attachment file is, since the comment body itself is still fully
 * preservable without its author.
 */
import type { PrismaClient } from "@prisma/client";
import { MessageDirection, TicketHistoryType } from "@prisma/client";
import type { LegacyCommentRow } from "@/lib/services/legacy-migration/sql-source-client";
import { getLedgerEntry, recordLedgerSuccess, recordLedgerFailure } from "@/lib/services/legacy-migration/ledger";
import { normalizeEmail } from "@/lib/services/email-identity";

export interface CommentImportContext {
  usernameToUserId: Map<string, string>;
  ticketIdByLegacyTicketId: Map<number, string>;
  dryRun: boolean;
}

export interface CommentImportOutcome {
  legacyCommentId: number;
  status: "created" | "reused" | "failed" | "skipped_no_ticket";
  targetId?: string;
  authorResolved: boolean;
  error?: string;
}

/** Exact UserName match first (case-insensitive key, same convention as user-reconciliation.ts), then exact normalized-email match — never a display-name/fuzzy match. */
function resolveCommentAuthorId(createdBy: string | null, usernameToUserId: Map<string, string>, emailToUserId: Map<string, string>): string | null {
  if (!createdBy) return null;
  const trimmed = createdBy.trim();
  if (!trimmed) return null;
  const byUserName = usernameToUserId.get(trimmed);
  if (byUserName) return byUserName;
  const byEmail = emailToUserId.get(normalizeEmail(trimmed));
  if (byEmail) return byEmail;
  return null;
}

export async function importOneLegacyComment(
  db: PrismaClient,
  row: LegacyCommentRow,
  ctx: CommentImportContext,
  emailToUserId: Map<string, string>
): Promise<CommentImportOutcome> {
  const legacyKey = String(row.Id);

  const existingLedger = await getLedgerEntry(db, "COMMENT", legacyKey);
  if (existingLedger?.status === "SUCCEEDED" && existingLedger.targetId) {
    return { legacyCommentId: row.Id, status: "reused", targetId: existingLedger.targetId, authorResolved: true };
  }

  try {
    if (!row.Ticket_Messages) {
      throw new Error(`Comment ${row.Id}: Ticket_Messages is null — cannot link to a ticket.`);
    }
    const ticketId = ctx.ticketIdByLegacyTicketId.get(row.Ticket_Messages);
    if (!ticketId) {
      return { legacyCommentId: row.Id, status: "skipped_no_ticket", authorResolved: false };
    }

    const body = row.Message?.trim() || "";
    const authorId = resolveCommentAuthorId(row.CreatedBy, ctx.usernameToUserId, emailToUserId);
    const isInternal = row.isHidden === true || row.isPublic === false;
    const direction = isInternal ? MessageDirection.INTERNAL_NOTE : MessageDirection.OUTBOUND;
    const createdAt = row.DateSent ?? new Date(0); // extremely defensive; DateSent absence would be a real data problem worth surfacing via the report's warnings, not a crash.
    if (!row.DateSent) {
      throw new Error(`Comment ${row.Id}: legacy DateSent is missing — refusing to substitute the migration's execution time for a historical date.`);
    }

    if (ctx.dryRun) {
      return { legacyCommentId: row.Id, status: "created", authorResolved: !!authorId };
    }

    const message = await db.$transaction(async (tx) => {
      const created = await tx.ticketMessage.create({
        data: { ticketId, authorId, body, direction, isInternal, createdAt, updatedAt: createdAt },
      });
      await tx.ticketHistory.create({
        data: {
          ticketId,
          changedById: authorId,
          type: TicketHistoryType.COMMENT_ADDED,
          description: `Legacy comment #${row.Id} migrated.${authorId ? "" : " Author unresolved."}`,
          createdAt,
        },
      });
      return created;
    });

    await recordLedgerSuccess(db, "COMMENT", legacyKey, message.id);
    return { legacyCommentId: row.Id, status: "created", targetId: message.id, authorResolved: !!authorId };
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : String(error);
    if (!ctx.dryRun) await recordLedgerFailure(db, "COMMENT", legacyKey, errMessage);
    return { legacyCommentId: row.Id, status: "failed", authorResolved: false, error: errMessage };
  }
}
