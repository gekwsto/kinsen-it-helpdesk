/**
 * Pure, universal attachment-validation constants — no Node built-ins
 * (`crypto`, `path`), unlike lib/attachment-policy.ts, so this is safe to
 * import from a "use client" component. lib/attachment-policy.ts re-exports
 * the same MAX_ATTACHMENT_SIZE_BYTES/ALLOWED_ATTACHMENT_MIME_TYPES/
 * isAllowedAttachmentMimeType bindings from here (every existing server
 * import site is unaffected), and this is now the single source of truth —
 * every client-side picker (the shared AttachmentDropzone,
 * components/attachments/attachment-dropzone.tsx) classifies files with
 * classifyAttachmentFile() below, and every web/integration upload route
 * enforces the SAME rule server-side via validateAttachmentUpload() in
 * lib/attachment-policy.ts (which additionally verifies email-file content).
 */

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — the cap the upload routes have always enforced.

/**
 * Standard (non-email) types — accepted by their browser-reported MIME type,
 * exactly as before. Also the rule the INBOUND EMAIL ingestion paths use
 * (lib/ticket-email-service.ts, lib/services/pending-ticket-service.ts) via
 * isAllowedAttachmentMimeType — deliberately unchanged by the email-file
 * support below, which applies to user/integration uploads only.
 */
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
] as const;

export function isAllowedAttachmentMimeType(mimeType: string): boolean {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Short display label per MIME type — UI-only (badges/helper text), never consulted for validation itself. */
export const ATTACHMENT_MIME_TYPE_LABELS: Record<string, string> = {
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "text/plain": "TXT",
  "application/zip": "ZIP",
  "application/vnd.ms-outlook": "MSG",
  "message/rfc822": "EML",
};

/**
 * Email message files. Browsers report these inconsistently (Chrome/Edge on
 * Windows: application/vnd.ms-outlook for .msg; macOS often an empty string;
 * some systems application/octet-stream), so they are identified by
 * EXTENSION plus an accepted (possibly generic/empty) MIME type here, and
 * by their actual CONTENT server-side (OLE2 compound-file signature for
 * .msg, RFC 822 header block for .eml — see validateAttachmentUpload). The
 * stored MIME type is always normalized to `canonicalMimeType`. The file is
 * stored byte-for-byte; nothing is parsed, converted or extracted.
 */
export const EMAIL_ATTACHMENT_TYPES = {
  msg: {
    extension: ".msg",
    label: "MSG",
    description: "Microsoft Outlook Message",
    canonicalMimeType: "application/vnd.ms-outlook",
    acceptedMimeTypes: ["application/vnd.ms-outlook", "application/x-ole-storage", "application/cdfv2", "application/octet-stream", ""],
  },
  eml: {
    extension: ".eml",
    label: "EML",
    description: "Email Message",
    canonicalMimeType: "message/rfc822",
    acceptedMimeTypes: ["message/rfc822", "application/octet-stream", "text/plain", ""],
  },
} as const;
export type EmailAttachmentKind = keyof typeof EMAIL_ATTACHMENT_TYPES;

/** Value for every file input's `accept` attribute — MIME types plus the email extensions (whose MIME types are unreliable). */
export const ATTACHMENT_ACCEPT_ATTRIBUTE = [...ALLOWED_ATTACHMENT_MIME_TYPES, "message/rfc822", "application/vnd.ms-outlook", ".msg", ".eml"].join(",");

/** Human-readable list for helper text. */
export const ATTACHMENT_ALLOWED_LABELS = ["JPG", "PNG", "GIF", "WEBP", "PDF", "DOC", "DOCX", "XLS", "XLSX", "TXT", "ZIP", "MSG", "EML"];

export type AttachmentClassification =
  | { ok: true; mimeType: string; emailKind: EmailAttachmentKind | null }
  | { ok: false; code: "too_large" | "type_not_allowed"; message: string };

/** Lower-cased extension including the dot (".msg"), or "" when there is none. */
export function attachmentExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/**
 * THE shared name/type/size rule (client + server). Server-side
 * validateAttachmentUpload() runs this first, then verifies email content.
 */
export function classifyAttachmentFile(file: { name: string; type: string; size: number }): AttachmentClassification {
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) return { ok: false, code: "too_large", message: "File too large (max 10MB)" };
  const ext = attachmentExtension(file.name);
  const type = (file.type || "").toLowerCase();
  for (const [kind, def] of Object.entries(EMAIL_ATTACHMENT_TYPES) as [EmailAttachmentKind, (typeof EMAIL_ATTACHMENT_TYPES)[EmailAttachmentKind]][]) {
    if (ext !== def.extension) continue;
    // A .msg/.eml name ALWAYS follows the email rule (accepted MIME list +
    // server-side content check) — it never falls through to the standard
    // MIME rule under some other type.
    if ((def.acceptedMimeTypes as readonly string[]).includes(type)) return { ok: true, mimeType: def.canonicalMimeType, emailKind: kind };
    return { ok: false, code: "type_not_allowed", message: "File type not allowed" };
  }
  if (isAllowedAttachmentMimeType(type)) return { ok: true, mimeType: type, emailKind: null };
  return { ok: false, code: "type_not_allowed", message: "File type not allowed" };
}

export type AttachmentIconKind = "image" | "pdf" | "sheet" | "archive" | "email" | "document";

/** Icon category for display — by stored MIME type, falling back to the filename's extension. */
export function attachmentIconKind(mimeType: string | null | undefined, name?: string): AttachmentIconKind {
  const type = (mimeType || "").toLowerCase();
  const ext = name ? attachmentExtension(name) : "";
  if (type === "message/rfc822" || type === "application/vnd.ms-outlook" || ext === ".msg" || ext === ".eml") return "email";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.includes("spreadsheet") || type.includes("excel")) return "sheet";
  if (type === "application/zip") return "archive";
  return "document";
}
