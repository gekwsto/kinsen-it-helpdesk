import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, formatDistanceToNow } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTicketNumber(num: number): string {
  return `KIN-${num}`;
}

export function formatDate(date: Date | string): string {
  return format(new Date(date), "dd MMM yyyy");
}

export function formatDateTime(date: Date | string): string {
  return format(new Date(date), "dd MMM yyyy HH:mm");
}

export function formatRelative(date: Date | string): string {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
}

/** Plain-text snippet from an HTML email body — used for list-row previews (e.g. Pending Tickets). Not a sanitizer; never used for rendering as HTML. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const codePoint = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return HTML_ENTITY_MAP[code.toLowerCase()] ?? match;
  });
}

/**
 * Full-length, readable plain-text rendering of an HTML email body (e.g.
 * PendingTicket.body — always real HTML, see lib/email-ticket-parser.ts,
 * which wraps even a genuinely plain-text source in `<p>${escapeHtml(...)}
 * </p>` at ingestion) — used where the FULL content must be shown (the
 * Pending Ticket preview dialog), unlike stripHtmlToText's single-line,
 * whitespace-collapsed snippet.
 *
 * Deliberately never returns markup and is meant to be rendered as plain
 * text (e.g. inside a `whitespace-pre-wrap` element), never via
 * `dangerouslySetInnerHTML` — inbound email HTML is untrusted external
 * content, so this converts block-level structure into real newlines
 * BEFORE stripping every tag, giving a readable paragraph/line-break
 * layout without ever executing or re-rendering any of the original
 * markup. `<script>`/`<style>` blocks are dropped entirely (content
 * included), not just unwrapped.
 */
export function htmlToReadableText(html: string): string {
  const withBreaks = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    // Paragraph-level block tags get a blank line on BOTH sides — a real
    // paragraph break, not just a line break (collapsed back down to a
    // single blank line below if several are adjacent, e.g. empty divs).
    .replace(/<\/?(p|div|h[1-6]|blockquote)[^>]*>/gi, "\n\n")
    // List/table-row tags get a single line break, not a blank line —
    // items read as one-per-line, not double-spaced.
    .replace(/<\/(li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "");
  const textOnly = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, ""));
  return textOnly
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    // Collapse 3+ consecutive blank lines down to a single blank line —
    // preserves real paragraph breaks without leaving huge dead gaps from
    // dense block-tag nesting.
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function generateTicketEmailSubject(
  ticketNumber: number,
  title: string
): string {
  return `[${formatTicketNumber(ticketNumber)}] ${title}`;
}

export function extractTicketNumberFromSubject(subject: string): number | null {
  const match = subject.match(/\[KIN-(\d+)\]/i);
  return match ? parseInt(match[1], 10) : null;
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "...";
}

export function getInitials(name?: string | null): string {
  if (!name) return "?";
  return name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
