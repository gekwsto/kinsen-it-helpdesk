/**
 * Shared, pure-ish (DB-read-only, no Graph, no filesystem writes)
 * correlation helpers for historical email attachment recovery — used by
 * BOTH scripts/diagnose-attachment-graph-recovery.ts (bulk, read-only
 * inventory) and scripts/recover-attachment-from-graph.ts (single-record,
 * write-capable recovery). Kept in one module specifically so the two
 * tools can never drift on what counts as "this row's verified source
 * email identity" or "a unique attachment-name match" — the single-record
 * tool's own revalidation (required immediately before ever writing a
 * file) reuses this EXACT code, not a reimplementation that could subtly
 * diverge from the bulk diagnostic's own logic.
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR } from "@/lib/attachment-policy";

export type Row = {
  kind: "ticket" | "pending";
  id: string;
  ownerId: string; // ticketId or pendingTicketId
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
};

export async function fileExistsLocally(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// `privatePath`'s construction MUST match the canonical path every real
// download route (and ingestion path) already uses — this is the single
// source of truth, not a parallel convention: `path.join(UPLOAD_DIR,
// ticketId, filename)`, exactly as app/api/tickets/[id]/attachments/
// [attachmentId]/route.ts's own GET handler builds it (that route never
// reads TicketAttachment.path, for the same reason); `path.join(UPLOAD_DIR,
// "pending", pendingTicketId, filename)` exactly as lib/services/
// pending-ticket-service.ts's accept-time migration step builds it. A file
// this tool writes is found by the app's existing routes with zero changes.
export function storagePaths(row: Row): { privatePath: string; legacyPath: string } {
  if (row.kind === "ticket") {
    return {
      privatePath: path.join(UPLOAD_DIR, row.ownerId, row.filename),
      legacyPath: path.join(LEGACY_PUBLIC_UPLOAD_DIR, row.ownerId, row.filename),
    };
  }
  return {
    privatePath: path.join(UPLOAD_DIR, "pending", row.ownerId, row.filename),
    legacyPath: path.join(LEGACY_PUBLIC_UPLOAD_DIR, "pending", row.ownerId, row.filename),
  };
}

/** Exactly one distinct mailbox for this messageId, or "unresolved" — never guesses among several, never falls back to a default mailbox. */
export async function resolveMailbox(emailMessageId: string): Promise<{ ok: true; mailbox: string } | { ok: false }> {
  const logs = await prisma.emailProcessingLog.findMany({
    where: { messageId: emailMessageId, mailbox: { not: null } },
    select: { mailbox: true },
  });
  const distinct = [...new Set(logs.map((l) => l.mailbox!))];
  if (distinct.length !== 1) return { ok: false };
  return { ok: true, mailbox: distinct[0] };
}

/** The emailMessageId the owning entity was ingested from, or null. For a ticket-level TicketAttachment (messageId: null) this is the Ticket's own emailMessageId (the original creating email); for a reply attachment it's that specific TicketMessage's own emailMessageId (a later email in the same thread). */
export async function resolveEmailMessageId(row: Row): Promise<string | null> {
  if (row.kind === "pending") {
    const pending = await prisma.pendingTicket.findUnique({ where: { id: row.ownerId }, select: { emailMessageId: true } });
    return pending?.emailMessageId ?? null;
  }
  const attachment = await prisma.ticketAttachment.findUnique({
    where: { id: row.id },
    select: { messageId: true, ticket: { select: { emailMessageId: true } } },
  });
  if (!attachment) return null;
  if (attachment.messageId) {
    const msg = await prisma.ticketMessage.findUnique({ where: { id: attachment.messageId }, select: { emailMessageId: true } });
    if (msg?.emailMessageId) return msg.emailMessageId;
  }
  return attachment.ticket.emailMessageId ?? null;
}

export type AttachmentNameMatchResult<T> = { status: "none" } | { status: "ambiguous"; count: number } | { status: "found"; match: T };

/**
 * Name is the SOLE uniqueness gate for picking a candidate attachment on a
 * verified source message — Graph's own reported `size` is explicitly NOT
 * used to disambiguate between same-named candidates (see GRAPH METADATA
 * SIZE RELIABILITY in the diagnostic script's own doc comment: Graph's
 * `size` property is not guaranteed to equal the actual decoded payload
 * length, so it can't be trusted as a second signal either). Zero matches
 * -> "none." Two or more -> "ambiguous," never guessed.
 */
export function findUniqueAttachmentByName<T extends { name: string }>(attachments: T[], originalName: string): AttachmentNameMatchResult<T> {
  const nameMatches = attachments.filter((a) => a.name === originalName);
  if (nameMatches.length === 0) return { status: "none" };
  if (nameMatches.length > 1) return { status: "ambiguous", count: nameMatches.length };
  return { status: "found", match: nameMatches[0] };
}
