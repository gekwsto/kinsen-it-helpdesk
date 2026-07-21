import { type GraphMailMessage, type GraphAttachment } from "@/lib/microsoft-graph";
import { extractTicketNumberFromSubject, formatTicketNumber } from "@/lib/utils";

export interface ParsedEmail {
  subject: string;
  fromEmail: string;
  fromName: string;
  bodyHtml: string;
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
}

export function parseIncomingEmail(message: GraphMailMessage): ParsedEmail {
  const existingTicketNumber = extractTicketNumberFromSubject(message.subject);

  const attachments: ParsedAttachment[] = (message.attachments ?? [])
    .filter((a): a is GraphAttachment & { contentBytes: string } => !!a.contentBytes)
    .map((a) => ({
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      contentBytes: a.contentBytes,
    }));

  const isHtml = message.body.contentType === "html";

  return {
    subject: cleanSubject(message.subject),
    fromEmail: message.from.emailAddress.address,
    fromName: message.from.emailAddress.name,
    bodyHtml: isHtml ? message.body.content : `<p>${escapeHtml(message.body.content)}</p>`,
    bodyText: isHtml ? stripHtml(message.body.content) : message.body.content,
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

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

export function buildAutoReplyHtml(params: {
  ticketNumber: number;
  ticketTitle: string;
  requesterName: string;
  appUrl: string;
}): string {
  const { ticketNumber, ticketTitle, requesterName, appUrl } = params;
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
    <p>Dear ${requesterName},</p>
    <p>Thank you for contacting Kinsen IT Support. Your request has been received and a ticket has been created.</p>
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Ticket Reference:</strong> <span style="color: #3b82f6; font-weight: bold;">[${ref}]</span></p>
      <p style="margin: 0 0 8px 0;"><strong>Subject:</strong> ${ticketTitle}</p>
      <p style="margin: 0;"><strong>Status:</strong> Open</p>
    </div>
    <p>Our IT team will review your request and get back to you as soon as possible.</p>
    <p>You can track your ticket status by <a href="${appUrl}/tickets" style="color: #3b82f6;">logging into the IT Portal</a>.</p>
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
  ticketNumber: number;
  ticketTitle: string;
  statusName: string;
  closingMessage?: string;
  appUrl: string;
}): string {
  const { ticketNumber, ticketTitle, statusName, closingMessage, appUrl } = params;
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
    <p>Your support ticket has been <strong>closed</strong>.</p>
    <div style="background: white; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin: 16px 0;">
      <p style="margin: 0 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Ticket</p>
      <p style="margin: 0 0 12px 0; font-weight: 600;">[${ref}] ${ticketTitle}</p>
      <p style="margin: 0 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Final Status</p>
      <p style="margin: 0 ${closingMessage ? "0 12px 0" : ";"} color: #374151;">${statusName}</p>
      ${closingMessage ? `
      <p style="margin: 12px 0 4px 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">Note</p>
      <p style="margin: 0; color: #374151;">${closingMessage}</p>` : ""}
    </div>
    <p style="color: #374151;">
      If you have further questions or need to reopen this issue, please submit a new ticket or reply to this email.
    </p>
    <p>
      <a href="${appUrl}/tickets/new" style="background: #3b82f6; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block; font-weight: 500;">
        Open a New Ticket
      </a>
      &nbsp;
      <a href="${appUrl}/tickets" style="color: #3b82f6; padding: 10px 20px; text-decoration: none; display: inline-block;">
        View All My Tickets
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
