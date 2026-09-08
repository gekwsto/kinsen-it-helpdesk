import { convert as convertHtmlToText } from "html-to-text";
import { type GraphMailMessage, type GraphAttachment } from "@/lib/microsoft-graph";
import { extractTicketNumberFromSubject, formatTicketNumber } from "@/lib/utils";

export interface ParsedEmail {
  subject: string;
  fromEmail: string;
  fromName: string;
  // Original HTML as Graph returned it — kept for provenance/diagnostics
  // ONLY. Never persisted to PendingTicket.body / Ticket.description /
  // TicketMessage.body and never rendered (dangerouslySetInnerHTML or
  // otherwise) — see bodyText's own doc comment for why.
  bodyHtml: string;
  // The single canonical, human-readable representation of the email body —
  // this (never bodyHtml) is what gets persisted into PendingTicket.body,
  // Ticket.description and TicketMessage.body. Produced by
  // htmlToReadableText() below for an HTML body, or used verbatim (just
  // normalized) for an already-plain-text body — see parseIncomingEmail.
  bodyText: string;
  attachments: ParsedAttachment[];
  messageId: string;
  conversationId: string;
  receivedAt: Date;
  existingTicketNumber: number | null;
  internetMessageHeaders: Array<{ name: string; value: string }>;
  /** Recipient addresses (To only) — used to route a new pending ticket to a Department.inboundEmail match. */
  toEmails: string[];
}

export interface ParsedAttachment {
  name: string;
  contentType: string;
  size: number;
  contentBytes: string; // base64
  /**
   * Graph's own `isInline` flag on a fileAttachment — true for a
   * Content-Disposition: inline resource, the standards-compatible signal
   * for "this is a signature logo / image referenced via cid: inside the
   * HTML body," not a real user-facing attachment. Absent (undefined) is
   * treated as "not inline" — Graph only ever sends `true`, never `false`,
   * for genuinely inline parts in practice, but this stays defensive rather
   * than assuming that.
   */
  isInline?: boolean;
  /** Graph's contentId (the `cid:` a `<img src="cid:...">` in the HTML body references) — informational only, never persisted; not currently used to rewrite the readable body. */
  contentId?: string | null;
}

export function parseIncomingEmail(message: GraphMailMessage): ParsedEmail {
  const existingTicketNumber = extractTicketNumberFromSubject(message.subject);

  // Real downloadable attachments only — an inline resource (a signature
  // logo, a tracking pixel referenced via `cid:` inside the HTML body) is
  // never a genuine user-facing attachment. See ParsedAttachment.isInline's
  // doc comment: this is Graph's own Content-Disposition-derived signal, not
  // a hardcoded Outlook-specific filename/pattern guess.
  const attachments: ParsedAttachment[] = (message.attachments ?? [])
    .filter((a): a is GraphAttachment & { contentBytes: string } => !!a.contentBytes && !a.isInline)
    .map((a) => ({
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      contentBytes: a.contentBytes,
      isInline: a.isInline,
      contentId: a.contentId ?? null,
    }));

  const isHtml = message.body.contentType === "html";

  return {
    subject: cleanSubject(message.subject),
    fromEmail: message.from.emailAddress.address,
    fromName: message.from.emailAddress.name,
    bodyHtml: isHtml ? message.body.content : `<p>${escapeHtml(message.body.content)}</p>`,
    bodyText: isHtml ? htmlToReadableText(message.body.content) : normalizePlainText(message.body.content),
    attachments,
    messageId: message.internetMessageId,
    conversationId: message.conversationId,
    receivedAt: new Date(message.receivedDateTime),
    existingTicketNumber,
    internetMessageHeaders: message.internetMessageHeaders ?? [],
    toEmails: (message.toRecipients ?? []).map((r) => r.emailAddress.address).filter(Boolean),
  };
}

function cleanSubject(subject: string): string {
  return subject
    .replace(/^(Re:\s*|Fwd?:\s*)*/i, "")
    .replace(/\[KIN-\d+\]\s*/gi, "")
    .trim();
}

/**
 * The canonical HTML -> readable-text rule (BUG 1 fix). Uses html-to-text —
 * a real HTML parser (htmlparser2 under the hood), not a fragile
 * tag-stripping regex — so malformed/nested markup (the exact shape a real
 * Outlook/Word-generated email produces: <style>/@font-face blocks,
 * conditional comments, MsoNormal-class paragraphs, <o:p> Office markup)
 * degrades safely instead of leaking `<style>`/`<script>` content or partial
 * tags into the output. <style>/<script>/<head> content is dropped
 * entirely by html-to-text's default tag handling (never included in the
 * output at all, so there is nothing left needing removal afterwards); `a`
 * and `img` are configured below to never leak `javascript:` hrefs or
 * `src=` attributes into the text. The result is plain text ONLY — no HTML
 * tags survive, so it is always safe to display verbatim (whitespace-pre-wrap
 * text node, never dangerouslySetInnerHTML — see ticket-thread.tsx) even for
 * a hostile/malformed input (CASE I: script tags, event-handler attributes,
 * javascript: URIs never survive conversion — see
 * scripts/test-pending-ticket-email-ingestion.ts).
 */
export function htmlToReadableText(html: string): string {
  const raw = convertHtmlToText(html, {
    wordwrap: false,
    selectors: [
      // Keep link TEXT (useful, human-written content) but never the href —
      // a converted `javascript:`/`data:` URI has no business surviving
      // into a plain-text field that's never treated as a link anyway.
      { selector: "a", options: { ignoreHref: true } },
      // Images carry no readable text of their own; a `[Image]`-style
      // placeholder for every embedded logo/signature image would just be
      // noise ahead of the sender's actual message.
      { selector: "img", format: "skip" },
    ],
  });
  return normalizePlainText(raw);
}

/** Shared cleanup for BOTH branches above: collapse whitespace-only lines (e.g. a `&nbsp;`-only Word paragraph) and runs of 3+ blank lines down to one, trim the ends. Never touches genuine sender-written text. */
function normalizePlainText(text: string): string {
  return text
    .replace(/^[ \t ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A plausible-HTML-tag detector — deliberately loose (any `<letter-or-!-or-/
// ...>`-shaped run), NOT a validator. Only used to decide which branch of
// normalizeStoredEmailBody below to take; being loose here is the safe
// direction; a false positive just runs already-clean text through
// htmlToReadableText (still safe/idempotent — see that function's own doc
// comment), while a false negative would let real markup through unclean,
// which this pattern is broad enough to avoid in practice.
const LOOKS_LIKE_HTML = /<[a-zA-Z!/][^>\n]{0,300}>/;

/**
 * The defense-in-depth normalization boundary (GAP 1 fix) — called from
 * acceptPendingTicket right before PendingTicket.body is written into
 * Ticket.description / the initial TicketMessage.body. parseIncomingEmail's
 * own bodyText computation above already normalizes every NEWLY ingested
 * email at write time, but a PendingTicket row created BEFORE this fix was
 * deployed still has its old, raw-HTML body sitting in the database — this
 * function is what makes accepting one of those old rows safe too, without
 * needing any backfill/migration of PendingTicket rows themselves.
 *
 * Unlike parseIncomingEmail (which always KNOWS whether its source was HTML
 * or plain text — Graph's own body.contentType), this function is fed an
 * already-stored string of unknown provenance, so it has to decide for
 * itself: only run the HTML converter when the text actually still looks
 * like it contains markup (LOOKS_LIKE_HTML above); a body that's already
 * clean plain text (every row created after this fix, or a plain-text
 * email from before it) skips straight to the same trim/collapse cleanup,
 * with no risk of htmlToReadableText altering already-correct formatting.
 *
 * Idempotent by construction: htmlToReadableText's output is always
 * tag-free, so calling this function again on its own output can only ever
 * take the plain-text branch — "clean in -> clean out, HTML in -> clean
 * out" holds however many times it's applied.
 */
export function normalizeStoredEmailBody(body: string): string {
  return looksLikeHtml(body) ? htmlToReadableText(body) : normalizePlainText(body);
}

/**
 * Exposes the exact same "does this look like it contains HTML markup"
 * check normalizeStoredEmailBody uses internally — so a candidate-detection
 * pass (e.g. scripts/repair-historical-raw-html-tickets.ts, auditing
 * already-stored Ticket.description/TicketMessage.body rows for the
 * pre-fix raw-HTML bug) and the actual normalization decision are
 * provably the same rule, not two independently maintained regexes that
 * could quietly drift apart.
 */
export function looksLikeHtml(text: string): boolean {
  return LOOKS_LIKE_HTML.test(text);
}

/** Escapes a plain-text dynamic value before interpolating it into an HTML email template — every builder below must run every dynamic field (requester name, ticket title, status name, cancel/closing reason, etc.) through this first. Never used on values that are already-trusted HTML (e.g. a reply body composed elsewhere) — see buildTicketReplyNotificationHtml's own doc comment for that distinction. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

/**
 * The single template for the "ticket created" lifecycle notification —
 * fired once a real Ticket exists with a real ticketNumber, for BOTH
 * creation paths (POST /api/tickets, and acceptPendingTicket() once an
 * emailed-in PendingTicket is accepted). Replaces the old, never-actually-
 * wired-up buildAutoReplyHtml — this is the only creation-email template now
 * ("δεν αφήνεις δύο templates που εξυπηρετούν το ίδιο lifecycle event").
 * `requesterName` and `closingMessage`-style dynamic fields are always
 * escaped before interpolation — see escapeHtml above.
 */
export function buildTicketCreatedNotificationHtml(params: {
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  requesterName: string | null;
  statusName: string;
  appUrl: string;
}): string {
  const { ticketId, ticketNumber, ticketTitle, requesterName, statusName, appUrl } = params;
  const ref = formatTicketNumber(ticketNumber);
  const greetingName = requesterName ? escapeHtml(requesterName) : "there";
  const ticketUrl = `${appUrl}/tickets/${ticketId}`;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1e3a5f; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 20px;">Kinsen IT Support</h1>
  </div>
  <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p>Dear ${greetingName},</p>
    <p>Thank you for contacting Kinsen IT Support. Your request has been received and a ticket has been created.</p>
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Ticket Reference:</strong> <span style="color: #3b82f6; font-weight: bold;">[${ref}]</span></p>
      <p style="margin: 0 0 8px 0;"><strong>Subject:</strong> ${escapeHtml(ticketTitle)}</p>
      <p style="margin: 0;"><strong>Status:</strong> ${escapeHtml(statusName)}</p>
    </div>
    <p>Our IT team will review your request and get back to you as soon as possible.</p>
    <p>
      <a href="${ticketUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 500;">
        View Your Ticket
      </a>
    </p>
    <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">
      <strong>Important:</strong> When replying to this email, please keep <strong>[${ref}]</strong> in the subject line so your reply is linked to this ticket.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="color: #6b7280; font-size: 12px; margin: 0;">
      Kinsen IT Support | kinsenitsupport@kinsen.gr
    </p>
  </div>
</body>
</html>`;
}

export function buildReplyNotificationHtml(params: {
  ticketNumber: number;
  ticketTitle: string;
  agentName: string;
  replyBody: string;
  appUrl: string;
}): string {
  const { ticketNumber, ticketTitle, agentName, replyBody, appUrl } = params;
  const ref = formatTicketNumber(ticketNumber);

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1e3a5f; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 20px;">Kinsen IT Support</h1>
  </div>
  <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p><strong>${agentName}</strong> from the IT team has replied to your ticket:</p>
    <div style="background: white; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
      <p style="margin: 0 0 8px 0; color: #6b7280; font-size: 12px;">[${ref}] ${ticketTitle}</p>
      <div>${replyBody}</div>
    </div>
    <p>
      <a href="${appUrl}/tickets" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">
        View Ticket
      </a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">
      To reply, simply respond to this email keeping <strong>[${ref}]</strong> in the subject line.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="color: #6b7280; font-size: 12px; margin: 0;">
      Kinsen IT Support | kinsenitsupport@kinsen.gr
    </p>
  </div>
</body>
</html>`;
}

export function buildTicketReplyNotificationHtml(params: {
  ticketNumber: number;
  ticketTitle: string;
  agentName: string;
  replyBody: string;
  statusName: string;
  appUrl: string;
}): string {
  const { ticketNumber, ticketTitle, agentName, replyBody, statusName, appUrl } = params;
  const ref = formatTicketNumber(ticketNumber);

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1e3a5f; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 20px;">Kinsen IT Support</h1>
  </div>
  <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p><strong>${agentName}</strong> from the IT team has replied to your ticket:</p>
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Ticket</p>
      <p style="margin: 0 0 12px 0; font-weight: 600;">[${ref}] ${ticketTitle}</p>
      <p style="margin: 0 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Status</p>
      <p style="margin: 0 0 12px 0; color: #374151;">${statusName}</p>
    </div>
    <div style="background: white; border-left: 4px solid #3b82f6; padding: 16px; margin: 16px 0; border-radius: 0 6px 6px 0;">
      <p style="margin: 0 0 8px 0; color: #6b7280; font-size: 12px;">Reply from ${agentName}:</p>
      <div style="color: #1f2937;">${replyBody}</div>
    </div>
    <p>
      <a href="${appUrl}/tickets" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 500;">
        View Ticket in Portal
      </a>
    </p>
    <p style="color: #6b7280; font-size: 14px;">
      To reply, simply respond to this email keeping <strong>[${ref}]</strong> in the subject line.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="color: #6b7280; font-size: 12px; margin: 0;">
      Kinsen IT Support | kinsenitsupport@kinsen.gr
    </p>
  </div>
</body>
</html>`;
}

export function buildTicketClosedNotificationHtml(params: {
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  statusName: string;
  closingMessage?: string;
  appUrl: string;
}): string {
  const { ticketId, ticketNumber, ticketTitle, statusName, closingMessage, appUrl } = params;
  const ref = formatTicketNumber(ticketNumber);
  const ticketUrl = `${appUrl}/tickets/${ticketId}`;
  const safeClosingMessage = closingMessage ? escapeHtml(closingMessage) : undefined;

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #1e3a5f; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 20px;">Kinsen IT Support</h1>
  </div>
  <div style="background: #f9fafb; padding: 24px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
    <p>Your support ticket has been <strong>closed</strong>.</p>
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Ticket</p>
      <p style="margin: 0 0 12px 0; font-weight: 600;">[${ref}] ${escapeHtml(ticketTitle)}</p>
      <p style="margin: 0 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Final Status</p>
      <p style="margin: 0 ${safeClosingMessage ? "0 12px 0" : ";"} color: #374151;">${escapeHtml(statusName)}</p>
      ${safeClosingMessage ? `
      <p style="margin: 12px 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Note</p>
      <p style="margin: 0; color: #374151;">${safeClosingMessage}</p>` : ""}
    </div>
    <p style="color: #374151;">
      If you have further questions, you can reply to this email to add a comment to this ticket, or submit a new ticket for a separate issue.
    </p>
    <p>
      <a href="${ticketUrl}" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 500;">
        View This Ticket
      </a>
      &nbsp;
      <a href="${appUrl}/tickets/new" style="color: #3b82f6; padding: 10px 20px; text-decoration: none; display: inline-block;">
        Open a New Ticket
      </a>
    </p>
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="color: #6b7280; font-size: 12px; margin: 0;">
      Kinsen IT Support | kinsenitsupport@kinsen.gr
    </p>
  </div>
</body>
</html>`;
}
