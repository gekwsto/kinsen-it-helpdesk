import { prisma } from "@/lib/prisma";
import { microsoftGraph } from "@/lib/microsoft-graph";
import {
  parseIncomingEmail,
  buildAutoReplyHtml,
  buildReplyNotificationHtml,
  type ParsedEmail,
} from "@/lib/email-ticket-parser";
import { formatTicketNumber } from "@/lib/utils";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { EmailLogAction } from "@prisma/client";
import path from "path";
import fs from "fs/promises";

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./public/uploads";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
const SUPPORT_EMAIL = (process.env.SUPPORT_EMAIL || "kinsenitsupport@kinsen.gr").toLowerCase();

// ── Loop / auto-reply protection ──────────────────────────────────────────────

const NO_REPLY_LOCAL_PARTS = new Set([
  "no-reply", "noreply", "do-not-reply", "donotreply",
  "bounce", "mailer-daemon", "mail-daemon", "postmaster",
  "auto-reply", "autoreply", "auto_reply",
  "notifications", "notification",
]);

function isLoopEmail(parsed: ParsedEmail): boolean {
  const fromLower = parsed.fromEmail.toLowerCase();

  // 1. Own support mailbox — would create infinite reply loop
  if (fromLower === SUPPORT_EMAIL) return true;

  // 2. No-reply / system sender local-part
  const localPart = fromLower.split("@")[0];
  if (NO_REPLY_LOCAL_PARTS.has(localPart)) return true;

  // 3. Standard and vendor-specific headers
  const header = (name: string): string =>
    (
      parsed.internetMessageHeaders.find(
        (h) => h.name.toLowerCase() === name.toLowerCase()
      )?.value ?? ""
    )
      .toLowerCase()
      .trim();

  // RFC 3834 — authoritative auto-response indicator
  const autoSubmitted = header("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;

  // RFC 2076 email list precedence
  const precedence = header("precedence");
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true;

  // Microsoft Exchange auto-reply suppression
  if (header("x-auto-response-suppress")) return true;

  // Various MTA / client auto-reply headers
  if (header("x-autoreply") || header("x-auto-reply")) return true;

  // Mailing list loop prevention
  if (header("x-loop")) return true;

  return false;
}

// ── Main processing loop ──────────────────────────────────────────────────────

export async function processInboundEmails(): Promise<{
  created: number;
  appended: number;
  skipped: number;
  errors: number;
  runId: string;
}> {
  // Open a run record so the admin dashboard can show timing
  const run = await prisma.emailPollRun.create({ data: {} });

  let created = 0;
  let appended = 0;
  let skipped = 0;
  let errors = 0;
  let lastError: string | null = null;

  let messages: Awaited<ReturnType<typeof microsoftGraph.getUnreadMessages>> = [];

  try {
    messages = await microsoftGraph.getUnreadMessages(50);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = msg;
    errors++;
    await prisma.emailPollRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), errors, lastError, succeeded: false },
    });
    throw err;
  }

  for (const message of messages) {
    let parsed: ParsedEmail | null = null;

    try {
      parsed = parseIncomingEmail(message);

      // ── Loop / auto-reply protection ──────────────────────────────────────
      if (isLoopEmail(parsed)) {
        await logEmail(run.id, parsed, "SKIPPED_LOOP");
        await microsoftGraph.markAsRead(message.id);
        skipped++;
        continue;
      }

      // ── Message-ID deduplication ──────────────────────────────────────────
      const duplicate = await prisma.ticketMessage.findFirst({
        where: { emailMessageId: parsed.messageId },
        select: { id: true },
      });
      if (duplicate) {
        await logEmail(run.id, parsed, "SKIPPED_DUPLICATE");
        await microsoftGraph.markAsRead(message.id);
        skipped++;
        continue;
      }

      // ── Find or create the requester ──────────────────────────────────────
      let user = await prisma.user.findUnique({
        where: { email: parsed.fromEmail },
        select: { id: true },
      });
      if (!user) {
        user = await prisma.user.create({
          data: { email: parsed.fromEmail, name: parsed.fromName || undefined },
          select: { id: true },
        });
      }

      // ── Route: append or create ───────────────────────────────────────────
      let ticketId: string | null = null;

      if (parsed.existingTicketNumber !== null) {
        const ticket = await prisma.ticket.findUnique({
          where: { ticketNumber: parsed.existingTicketNumber },
          select: { id: true, ticketNumber: true, title: true },
        });

        if (ticket) {
          await appendEmailReply(parsed, ticket, user.id);
          ticketId = ticket.id;
          await logEmail(run.id, parsed, "APPENDED_REPLY", ticketId);
          appended++;
        } else {
          // Ticket ref in subject but ticket not found — create new
          const newTicket = await createTicketFromEmail(parsed, user.id);
          ticketId = newTicket.id;
          await logEmail(run.id, parsed, "CREATED_TICKET", ticketId);
          created++;
        }
      } else {
        const newTicket = await createTicketFromEmail(parsed, user.id);
        ticketId = newTicket.id;
        await logEmail(run.id, parsed, "CREATED_TICKET", ticketId);
        created++;
      }

      // ── Move processed email ──────────────────────────────────────────────
      await microsoftGraph.markAsRead(message.id);
      await microsoftGraph.moveMessage(message.id, "Processed");
    } catch (err) {
      // One email failure must not abort the whole batch.
      // Leave the email UNREAD so it is retried on the next poll.
      const errMsg = err instanceof Error ? err.message : String(err);
      lastError = errMsg;
      errors++;

      // Best-effort log — swallow any secondary DB error
      await prisma.emailProcessingLog
        .create({
          data: {
            runId: run.id,
            messageId: parsed?.messageId ?? null,
            fromEmail: parsed?.fromEmail ?? null,
            subject: parsed?.subject ?? null,
            action: "FAILED",
            error: errMsg,
          },
        })
        .catch(() => {});

      console.error(`[email] Failed to process message ${message.id}:`, err);
    }
  }

  // Close the run record
  await prisma.emailPollRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      created,
      appended,
      skipped,
      errors,
      lastError,
      succeeded: errors === 0,
    },
  });

  return { created, appended, skipped, errors, runId: run.id };
}

// ── Logging helper ────────────────────────────────────────────────────────────

async function logEmail(
  runId: string,
  parsed: ParsedEmail,
  action: EmailLogAction,
  ticketId?: string | null
) {
  await prisma.emailProcessingLog.create({
    data: {
      runId,
      messageId: parsed.messageId,
      fromEmail: parsed.fromEmail,
      subject: parsed.subject,
      action,
      ticketId: ticketId ?? null,
    },
  });
}

// ── Append reply to existing ticket ──────────────────────────────────────────

async function appendEmailReply(
  parsed: ParsedEmail,
  ticket: { id: string; ticketNumber: number; title: string },
  userId: string
) {
  const msg = await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      authorId: userId,
      body: parsed.bodyHtml,
      direction: "INBOUND",
      emailMessageId: parsed.messageId,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
    },
    include: {
      author: { select: { id: true, name: true, email: true, image: true, role: true } },
      attachments: true,
    },
  });

  await saveEmailAttachments(parsed.attachments, ticket.id, msg.id, userId);

  await prisma.ticketHistory.create({
    data: {
      ticketId: ticket.id,
      changedById: userId,
      type: "COMMENT_ADDED",
      description: `Email reply received from ${parsed.fromEmail}`,
    },
  });

  // Notify anyone currently viewing the ticket
  publishTicketEvent("TICKET_MESSAGE_CREATED", ticket.id, userId, msg);
}

// ── Create new ticket from email ─────────────────────────────────────────────

async function createTicketFromEmail(parsed: ParsedEmail, requesterId: string) {
  const defaultStatus = await prisma.ticketStatus.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (!defaultStatus) throw new Error("No default ticket status configured");

  const ticket = await prisma.ticket.create({
    data: {
      title: parsed.subject || "Email Support Request",
      description: parsed.bodyHtml,
      source: "EMAIL",
      requesterId,
      statusId: defaultStatus.id,
      emailMessageId: parsed.messageId,
      emailThreadId: parsed.conversationId,
    },
    include: { requester: { select: { id: true, name: true, email: true } } },
  });

  const msg = await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      authorId: requesterId,
      body: parsed.bodyHtml,
      direction: "INBOUND",
      emailMessageId: parsed.messageId,
      fromEmail: parsed.fromEmail,
      fromName: parsed.fromName,
    },
    include: {
      author: { select: { id: true, name: true, email: true, image: true, role: true } },
      attachments: true,
    },
  });

  await saveEmailAttachments(parsed.attachments, ticket.id, msg.id, requesterId);

  await prisma.ticketHistory.create({
    data: {
      ticketId: ticket.id,
      changedById: requesterId,
      type: "CREATED",
      description: `Ticket created from email by ${parsed.fromEmail}`,
      newValue: "EMAIL",
    },
  });

  publishTicketEvent("TICKET_MESSAGE_CREATED", ticket.id, requesterId, msg);

  // Send auto-reply — failure must not abort ticket creation
  try {
    const ref = formatTicketNumber(ticket.ticketNumber);
    const html = buildAutoReplyHtml({
      ticketNumber: ticket.ticketNumber,
      ticketTitle: ticket.title,
      requesterName: parsed.fromName || parsed.fromEmail,
      appUrl: APP_URL,
    });
    await microsoftGraph.sendTicketReply({
      to: parsed.fromEmail,
      toName: parsed.fromName,
      subject: `Re: [${ref}] ${ticket.title}`,
      htmlBody: html,
      ticketNumber: ticket.ticketNumber,
    });
  } catch (err) {
    console.error("[email] Failed to send auto-reply:", err);
  }

  return ticket;
}

// ── Save base64 attachments to disk ──────────────────────────────────────────

async function saveEmailAttachments(
  attachments: Array<{ name: string; contentType: string; size: number; contentBytes: string }>,
  ticketId: string,
  messageId: string,
  uploadedById: string
) {
  for (const att of attachments) {
    try {
      const dir = path.join(UPLOAD_DIR, ticketId);
      await fs.mkdir(dir, { recursive: true });

      const safe = att.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filename = `${Date.now()}-${safe}`;
      const filePath = path.join(dir, filename);
      await fs.writeFile(filePath, Buffer.from(att.contentBytes, "base64"));

      await prisma.ticketAttachment.create({
        data: {
          ticketId,
          messageId,
          uploadedById,
          filename,
          originalName: att.name,
          mimeType: att.contentType,
          size: att.size,
          path: `/uploads/${ticketId}/${filename}`,
        },
      });
    } catch (err) {
      console.error(`[email] Failed to save attachment ${att.name}:`, err);
    }
  }
}

// ── Admin: create synthetic test ticket ──────────────────────────────────────

export async function createTestEmailTicket(): Promise<{
  id: string;
  ticketNumber: number;
  title: string;
}> {
  const now = new Date();
  const parsed: ParsedEmail = {
    messageId: `test-${now.getTime()}@test.local`,
    conversationId: `test-conv-${now.getTime()}`,
    subject: `Test Email Ticket — ${now.toISOString()}`,
    fromEmail: "test-sender@example.com",
    fromName: "Test Sender (Admin Test)",
    bodyHtml:
      "<p>This is a <strong>test ticket</strong> created via the admin email diagnostics panel to verify the email-to-ticket pipeline.</p>",
    bodyText: "This is a test ticket created via the admin email diagnostics panel.",
    existingTicketNumber: null,
    internetMessageHeaders: [],
    attachments: [],
    receivedAt: now,
  };

  let user = await prisma.user.findUnique({
    where: { email: parsed.fromEmail },
    select: { id: true },
  });
  if (!user) {
    user = await prisma.user.create({
      data: { email: parsed.fromEmail, name: parsed.fromName || undefined },
      select: { id: true },
    });
  }

  const ticket = await createTicketFromEmail(parsed, user.id);
  return { id: ticket.id, ticketNumber: ticket.ticketNumber, title: ticket.title };
}

// ── Send outbound reply from IT portal ───────────────────────────────────────

export async function sendTicketReplyEmail(params: {
  ticketId: string;
  agentName: string;
  replyBody: string;
}): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    include: { requester: { select: { email: true, name: true } } },
  });
  if (!ticket) throw new Error("Ticket not found");

  const ref = formatTicketNumber(ticket.ticketNumber);
  const html = buildReplyNotificationHtml({
    ticketNumber: ticket.ticketNumber,
    ticketTitle: ticket.title,
    agentName: params.agentName,
    replyBody: params.replyBody,
    appUrl: APP_URL,
  });

  await microsoftGraph.sendTicketReply({
    to: ticket.requester.email,
    toName: ticket.requester.name ?? undefined,
    subject: `Re: [${ref}] ${ticket.title}`,
    htmlBody: html,
    ticketNumber: ticket.ticketNumber,
  });
}
