import { randomUUID } from "crypto";
import path from "path";

/**
 * Shared attachment policy — the single source of truth for what counts as
 * an acceptable ticket attachment, previously only enforced (as inline
 * literals) by the WEB upload route (app/api/tickets/[id]/attachments/
 * route.ts). Email-originated attachments (lib/services/pending-ticket-
 * service.ts's savePendingAttachments, lib/ticket-email-service.ts's
 * saveEmailAttachments) went through NO equivalent check at all — an
 * inbound email could carry an attachment of any MIME type or size and it
 * would be written to disk and linked to a Ticket unconditionally. This
 * module lets every attachment-ingestion path — web upload and both email
 * paths — apply the exact same rule, rather than the two email paths each
 * re-declaring (and risking drifting from) their own copy of the list.
 */

// PRIVATE storage — deliberately NOT under public/. Next.js only ever
// serves files that live under the project's public/ directory; anything
// outside it (this default included) is unreachable by a direct static URL
// no matter what a client requests, so attachments can only ever be
// retrieved through the authenticated GET /api/tickets/[id]/attachments/
// [attachmentId] route (which reads from this same UPLOAD_DIR). This used
// to default to "./public/uploads" — a real, previously unauthenticated,
// statically-served attachment path. See LEGACY_PUBLIC_UPLOAD_DIR below and
// scripts/migrate-attachments-to-private-storage.ts for how attachments
// already written under the old location are carried forward.
export const UPLOAD_DIR = process.env.UPLOAD_DIR || "./storage/uploads";

// The OLD default, kept as its own named constant (never read from
// process.env — this is specifically "wherever attachments landed before
// this fix," not a currently-configurable location) purely so the
// migration script and any diagnostics have one canonical place to look for
// pre-existing files, instead of a magic string re-typed at each call site.
export const LEGACY_PUBLIC_UPLOAD_DIR = "./public/uploads";

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — same cap the web upload route has always enforced.

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "application/zip",
];

export function isAllowedAttachmentMimeType(mimeType: string): boolean {
  return ALLOWED_ATTACHMENT_MIME_TYPES.includes(mimeType);
}

/**
 * Turns an arbitrary, sender-controlled filename into one safe to use as a
 * path segment under UPLOAD_DIR — strips everything but a conservative
 * allowlist of characters, closing the same path-traversal surface
 * (`../`, an absolute path, a bare `/`) for an email-derived filename that
 * the web upload route has always closed for a browser-supplied one. Never
 * used on its own as the on-disk name (callers prefix it with a timestamp,
 * exactly like the existing web-upload convention) — this only guarantees
 * the segment itself cannot escape its intended directory.
 */
export function sanitizeAttachmentFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * The on-disk filename for a BRAND NEW attachment write (web upload, a
 * fresh pending-email attachment, a reply attachment) — used everywhere a
 * file is being written for the first time, with no prior identity to key
 * off. Previously every call site built this itself as
 * `${Date.now()}-${safe}` — millisecond-resolution, so two attachments with
 * the same original filename processed in the same loop (a realistic case:
 * one email with two identically-named attachments) could collide on the
 * exact same disk path, silently overwriting the first file's bytes with
 * the second's before either ever reached a database row. crypto.randomUUID()
 * has no such collision risk at any realistic scale.
 */
export function generateStoredFilename(originalName: string): string {
  return `${randomUUID()}-${sanitizeAttachmentFilename(originalName)}`;
}

/**
 * The on-disk filename used ONLY when migrating a PendingTicketAttachment
 * into a TicketAttachment at accept time (lib/services/pending-ticket-
 * service.ts's acceptPendingTicket) — deliberately deterministic (derived
 * from the source row's own durable id), unlike generateStoredFilename
 * above. This is what makes the migration step's own idempotency check a
 * real identity check instead of a filename-string coincidence: two
 * PendingTicketAttachment rows can legitimately share the same
 * originalName (two distinct MIME parts both called "invoice.pdf"), so
 * matching on originalName — or on the pending row's own on-disk filename,
 * which callers have no durable reason to treat as identity — could
 * conflate two different attachments or fail to recognize the same one
 * across a retry. Prefixing with the PendingTicketAttachment's own `id`
 * (never reused, never regenerated) makes "does a TicketAttachment for
 * this exact pending attachment already exist" answerable by construction,
 * with no schema change (no FK column) needed to record that relationship.
 */
export function buildMigratedAttachmentFilename(pendingAttachmentId: string, originalName: string): string {
  return `${pendingAttachmentId}-${sanitizeAttachmentFilename(originalName)}`;
}

/**
 * The path-traversal guard the authenticated download route
 * (app/api/tickets/[id]/attachments/[attachmentId]/route.ts) applies to a
 * TicketAttachment.filename read back from the database before it's ever
 * joined into a filesystem path. Every filename actually WRITTEN by this
 * app already comes from generateStoredFilename/buildMigratedAttachmentFilename
 * above (never containing "/", "\\", or ".."), so this only ever fires for
 * a row that somehow predates that guarantee — still checked unconditionally
 * rather than trusted, and exported as its own pure function so it can be
 * exercised directly by a test without needing a full authenticated HTTP
 * request (see scripts/test-pending-ticket-email-ingestion.ts's path-
 * traversal case).
 */
export function isSafeStoredFilename(filename: string): boolean {
  return !filename.includes("/") && !filename.includes("\\") && !filename.includes("..");
}

/**
 * Belt-and-suspenders companion to isSafeStoredFilename above: confirms the
 * fully joined, resolved file path still lands strictly inside the
 * directory it was supposed to (UPLOAD_DIR/<ticketId> or UPLOAD_DIR/pending/
 * <pendingTicketId>), never merely that the filename component looked safe
 * in isolation.
 */
export function resolvesInsideDir(filePath: string, expectedDir: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(expectedDir);
  return resolvedFile === resolvedDir || resolvedFile.startsWith(resolvedDir + path.sep);
}
