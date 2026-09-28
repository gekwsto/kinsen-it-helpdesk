/**
 * Pure, universal attachment-validation constants — no Node built-ins
 * (`crypto`, `path`), unlike lib/attachment-policy.ts, so this is safe to
 * import from a "use client" component. lib/attachment-policy.ts re-exports
 * the same MAX_ATTACHMENT_SIZE_BYTES/ALLOWED_ATTACHMENT_MIME_TYPES/
 * isAllowedAttachmentMimeType bindings from here (every existing server
 * import site is unaffected), and this is now the single source of truth —
 * client-side pickers (components/attachments/entity-attachments.tsx,
 * components/attachments/pending-attachments-field.tsx) import directly
 * from here instead of each hardcoding their own duplicate copy of these
 * values, which is what entity-attachments.tsx used to do.
 */

export const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — the cap the upload routes have always enforced.

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

/** Short display label per MIME type — UI-only (the `accept` attribute and the type badge), never consulted for validation itself (isAllowedAttachmentMimeType is). */
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
};
