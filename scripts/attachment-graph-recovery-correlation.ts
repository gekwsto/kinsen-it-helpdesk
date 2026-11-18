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

export type GraphFailureClassification = {
  /** Human-readable reason text — same wording the bulk diagnostic has always printed. */
  description: string;
  /**
   * True only for failures that will recur identically on EVERY subsequent
   * Graph call in this run (couldn't obtain a token at all, or the
   * credentials/permissions are flatly rejected) — never for a failure
   * that's plausibly specific to one message or one moment in time
   * (throttling, a transient server/network error). A bulk caller uses
   * this to decide "abort the whole batch" vs. "log and move to the next
   * record" (see scripts/bulk-recover-attachments-from-graph.ts).
   */
  systemic: boolean;
};

/**
 * Distinguishes WHY a Graph request didn't succeed — authentication,
 * authorization, throttling, and network/server errors are all genuine
 * REQUEST failures (we learned nothing about whether the message exists)
 * and must never be reported as "message not found"/"deleted." Only a
 * request that actually SUCCEEDED (HTTP 2xx) with zero matching messages
 * means the message is genuinely gone — see getMessageByInternetMessageId
 * in lib/microsoft-graph.ts, which represents that case by returning
 * `null`, never by throwing. Every thrown error reaching this function is
 * therefore, by construction, a request-level failure, not a "not found."
 * Parses lib/microsoft-graph.ts's own plain Error message text (its
 * `graphRequest`/`getAccessToken` helpers throw `Error`, not a typed
 * subclass, so this is necessarily text-based) — never includes the
 * Authorization header or token value, which graphRequest's own error
 * construction already excludes.
 */
export function classifyGraphFailure(err: unknown): GraphFailureClassification {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Failed to get access token/.test(msg)) {
    return { description: "authentication failure (could not obtain a Graph access token — check GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET)", systemic: true };
  }
  const statusMatch = msg.match(/Graph API error (\d+)/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401) return { description: "authentication failure (401 Unauthorized)", systemic: true };
    if (status === 403) return { description: "authorization failure (403 Forbidden — insufficient Graph API permissions for this mailbox)", systemic: true };
    if (status === 429) return { description: "throttled (429 Too Many Requests — Graph rate limit hit)", systemic: false };
    if (status >= 500) return { description: `Graph server error (${status})`, systemic: false };
    return { description: `Graph API error ${status}`, systemic: false };
  }
  return { description: "network or unknown error (no HTTP status could be parsed from the failure)", systemic: false };
}

export type CandidateSelection = {
  /** Locally missing rows with BOTH a resolvable emailMessageId and exactly one resolvable mailbox — the only rows eligible for recovery. */
  candidates: Row[];
  filePresentCount: number;
  noEmailCorrelationCount: number;
  mailboxUnresolvedCount: number;
};

/**
 * Enumerates every TicketAttachment/PendingTicketAttachment row and sorts
 * it into exactly one bucket, WITHOUT ever calling Graph (pure local-file
 * and DB-read checks only — identical in spirit to the bulk diagnostic's
 * own `--dry-run` pass, reused here rather than reimplemented) — the
 * "candidates" bucket is the ONLY one a bulk recovery run is ever allowed
 * to touch; rows with no_email_correlation or an unresolved mailbox are
 * excluded by construction, never guessed into eligibility.
 */
export async function selectRecoveryCandidates(): Promise<CandidateSelection> {
  const ticketAttachments = await prisma.ticketAttachment.findMany({
    select: { id: true, ticketId: true, filename: true, originalName: true, mimeType: true, size: true },
  });
  const pendingAttachments = await prisma.pendingTicketAttachment.findMany({
    select: { id: true, pendingTicketId: true, filename: true, originalName: true, mimeType: true, size: true },
  });
  const allRows: Row[] = [
    ...ticketAttachments.map((a) => ({ kind: "ticket" as const, id: a.id, ownerId: a.ticketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size })),
    ...pendingAttachments.map((a) => ({ kind: "pending" as const, id: a.id, ownerId: a.pendingTicketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size })),
  ];

  let filePresentCount = 0;
  const needsGraphCheck: Row[] = [];
  for (const row of allRows) {
    const { privatePath, legacyPath } = storagePaths(row);
    if ((await fileExistsLocally(privatePath)) || (await fileExistsLocally(legacyPath))) {
      filePresentCount++;
    } else {
      needsGraphCheck.push(row);
    }
  }

  let noEmailCorrelationCount = 0;
  let mailboxUnresolvedCount = 0;
  const candidates: Row[] = [];
  for (const row of needsGraphCheck) {
    const emailMessageId = await resolveEmailMessageId(row);
    if (!emailMessageId) {
      noEmailCorrelationCount++;
      continue;
    }
    const mailboxResult = await resolveMailbox(emailMessageId);
    if (!mailboxResult.ok) {
      mailboxUnresolvedCount++;
      continue;
    }
    candidates.push(row);
  }

  return { candidates, filePresentCount, noEmailCorrelationCount, mailboxUnresolvedCount };
}
