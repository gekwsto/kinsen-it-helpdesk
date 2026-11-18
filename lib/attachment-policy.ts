import { randomUUID } from "crypto";
import path from "path";
import { MAX_ATTACHMENT_SIZE_BYTES, ALLOWED_ATTACHMENT_MIME_TYPES, isAllowedAttachmentMimeType } from "@/lib/attachment-constants";

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
 *
 * The pure validation constants (MAX_ATTACHMENT_SIZE_BYTES,
 * ALLOWED_ATTACHMENT_MIME_TYPES, isAllowedAttachmentMimeType) now live in
 * lib/attachment-constants.ts and are re-exported below unchanged — that
 * module has no Node built-in imports, so client components (the creation
 * forms' attachment pickers) can import the SAME values directly instead of
 * duplicating them, while every existing server import of these three names
 * from "@/lib/attachment-policy" keeps working exactly as before.
 */
export { MAX_ATTACHMENT_SIZE_BYTES, ALLOWED_ATTACHMENT_MIME_TYPES, isAllowedAttachmentMimeType };

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

/**
 * The per-entity attachment directory shared by every entity attachment
 * route (Activity, Project, ...): `UPLOAD_DIR/<subdir>/<entityId>`. One
 * canonical builder rather than each route re-typing `path.join(UPLOAD_DIR,
 * "activities", id)` / `path.join(UPLOAD_DIR, "projects", id)` itself, so
 * the on-disk layout can never drift between entity types by a typo.
 */
export function entityAttachmentDir(subdir: "activities" | "projects", entityId: string): string {
  return path.join(UPLOAD_DIR, subdir, entityId);
}

/**
 * RFC 6266 / RFC 5987-compliant `Content-Disposition` header value for a
 * download, built from an uploader/sender-controlled `originalName` —
 * untrusted free text that may contain ANY Unicode codepoint (Greek, CJK,
 * emoji, U+202F NARROW NO-BREAK SPACE, etc.).
 *
 * THE BUG THIS FIXES: the WHATWG Fetch/Headers spec requires every header
 * VALUE to be a ByteString (every UTF-16 code unit in 0-255) — setting a
 * header containing even one character above U+00FF throws
 * `TypeError: Cannot convert argument to a ByteString because the
 * character at index N has a value of <code point> which is greater than
 * 255` the moment `new NextResponse(...)` tries to construct the Headers
 * object, crashing the whole route before any bytes are sent (confirmed in
 * production: a PNG named with a Greek/Latin mix including U+202F). Every
 * ticket/project/activity attachment download route previously built this
 * header with `attachment.originalName.replace(/[\r\n"]/g, "_")` for the
 * plain `filename="..."` parameter — that only ever stripped CR/LF/quotes,
 * never any OTHER non-Latin-1 character, so any real non-ASCII original
 * filename reached the header construction unmodified and crashed it.
 *
 * Fix, per RFC 6266 §4.3 / RFC 5987 (the two-parameter pattern every modern
 * browser already supports):
 *   - `filename="..."` is now a SAFE, PURE-ASCII fallback (every byte in
 *     the printable 0x20-0x7E range) for a client that only understands
 *     the plain parameter — any other character (Greek, CJK, U+202F, …)
 *     is replaced with "_"; the quoted-string's own two special
 *     characters (`"` and `\`) are *escaped* (`\"`/`\\`), not merely
 *     stripped, so a filename legitimately containing them still displays
 *     sensibly instead of being silently mangled.
 *   - `filename*=UTF-8''...` carries the REAL, full-Unicode original name
 *     as a percent-encoded UTF-8 octet sequence (RFC 5987) —
 *     `encodeURIComponent`'s output is always pure ASCII, so this half was
 *     never actually the cause of the crash; every modern browser prefers
 *     filename* over filename when both are present, so the user-visible
 *     saved filename is unaffected for any realistic client.
 *   - Control characters (0x00-0x1F, 0x7F — the existing CR/LF
 *     header-injection guard) are stripped from BOTH parameters up front,
 *     not just the ASCII fallback as before.
 */
export function buildContentDispositionHeader(originalName: string): string {
  const controlCharsStripped = originalName.replace(/[\x00-\x1f\x7f]/g, "");
  const asciiFallback =
    controlCharsStripped
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, (c) => `\\${c}`)
      .trim() || "download";
  const utf8Encoded = encodeURIComponent(controlCharsStripped);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;
}
