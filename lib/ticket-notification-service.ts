import { prisma } from "@/lib/prisma";
import { microsoftGraph } from "@/lib/microsoft-graph";
import {
  buildTicketReplyNotificationHtml,
  buildTicketClosedNotificationHtml,
} from "@/lib/email-ticket-parser";
import { formatTicketNumber } from "@/lib/utils";
import { EmailNotificationType, EmailNotificationStatus } from "@prisma/client";

const SUPPORT_EMAIL = (
  process.env.GRAPH_USER_EMAIL ||
  process.env.SUPPORT_EMAIL ||
  "kinsenitsupport@kinsen.gr"
).toLowerCase();

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

const NO_REPLY_LOCAL_PARTS = new Set([
  "no-reply", "noreply", "do-not-reply", "donotreply",
  "bounce", "mailer-daemon", "mail-daemon", "postmaster",
  "auto-reply", "autoreply", "auto_reply",
  "notifications", "notification",
]);

function isNotifiableEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower === SUPPORT_EMAIL) return false;
  const localPart = lower.split("@")[0];
  return !NO_REPLY_LOCAL_PARTS.has(localPart);
}

// ── Reply notification ────────────────────────────────────────────────────────

export async function notifyRequesterReply(params: {
  ticketId: string;
  messageId: string;
  agentName: string;
  replyBody: string;
}): Promise<void> {
  // Check message origin — skip inbound email messages and internal notes.
  // This prevents looping when the email poller appends an inbound reply.
  const msg = await prisma.ticketMessage.findUnique({
    where: { id: params.messageId },
    select: { direction: true, isInternal: true },
  });
  if (!msg || msg.direction === "INBOUND" || msg.isInternal) return;

  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    include: {
      requester: { select: { email: true, name: true } },
      status: { select: { name: true } },
    },
  });

  if (!ticket) return;

  const recipientEmail = ticket.requester.email;

  if (!isNotifiableEmail(recipientEmail)) {
    await writeLog({
      ticketId: ticket.id,
      messageId: params.messageId,
      recipientEmail,
      type: "REPLY",
      status: "SKIPPED",
    });
    return;
  }

  const ref = formatTicketNumber(ticket.ticketNumber);
  const html = buildTicketReplyNotificationHtml({
    ticketNumber: ticket.ticketNumber,
    ticketTitle: ticket.title,
    agentName: params.agentName,
    replyBody: params.replyBody,
    statusName: ticket.status.name,
    appUrl: APP_URL,
  });

  try {
    await microsoftGraph.sendMail({
      message: {
        subject: `Re: [${ref}] ${ticket.title}`,
        body: { contentType: "HTML", content: html },
        toRecipients: [
          {
            emailAddress: {
              address: recipientEmail,
              name: ticket.requester.name ?? undefined,
            },
          },
        ],
        internetMessageHeaders: [
          { name: "X-Ticket-Number", value: ref },
          { name: "Auto-Submitted", value: "auto-generated" },
          { name: "X-Auto-Response-Suppress", value: "All" },
        ],
      },
    });

    await writeLog({
      ticketId: ticket.id,
      messageId: params.messageId,
      recipientEmail,
      type: "REPLY",
      status: "SENT",
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await writeLog({
      ticketId: ticket.id,
      messageId: params.messageId,
      recipientEmail,
      type: "REPLY",
      status: "FAILED",
      error,
    });
    throw err;
  }
}

// ── Closed notification ───────────────────────────────────────────────────────

export async function notifyRequesterClosed(params: {
  ticketId: string;
  statusName: string;
  closingMessage?: string;
}): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    include: {
      requester: { select: { email: true, name: true } },
    },
  });

  if (!ticket) return;

  const recipientEmail = ticket.requester.email;

  if (!isNotifiableEmail(recipientEmail)) {
    await writeLog({
      ticketId: ticket.id,
      messageId: null,
      recipientEmail,
      type: "CLOSED",
      status: "SKIPPED",
    });
    return;
  }

  const ref = formatTicketNumber(ticket.ticketNumber);
  const html = buildTicketClosedNotificationHtml({
    ticketNumber: ticket.ticketNumber,
    ticketTitle: ticket.title,
    statusName: params.statusName,
    closingMessage: params.closingMessage,
    appUrl: APP_URL,
  });

  try {
    await microsoftGraph.sendMail({
      message: {
        subject: `[${ref}] Ticket closed`,
        body: { contentType: "HTML", content: html },
        toRecipients: [
          {
            emailAddress: {
              address: recipientEmail,
              name: ticket.requester.name ?? undefined,
            },
          },
        ],
        internetMessageHeaders: [
          { name: "X-Ticket-Number", value: ref },
          { name: "Auto-Submitted", value: "auto-generated" },
          { name: "X-Auto-Response-Suppress", value: "All" },
        ],
      },
    });

    await writeLog({
      ticketId: ticket.id,
      messageId: null,
      recipientEmail,
      type: "CLOSED",
      status: "SENT",
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await writeLog({
      ticketId: ticket.id,
      messageId: null,
      recipientEmail,
      type: "CLOSED",
      status: "FAILED",
      error,
    });
    throw err;
  }
}

// ── Internal logging helper ───────────────────────────────────────────────────

async function writeLog(params: {
  ticketId: string;
  messageId: string | null;
  recipientEmail: string;
  type: "REPLY" | "CLOSED";
  status: "SENT" | "FAILED" | "SKIPPED";
  error?: string;
}): Promise<void> {
  await prisma.emailNotificationLog
    .create({
      data: {
        ticketId: params.ticketId,
        messageId: params.messageId,
        recipientEmail: params.recipientEmail,
        type: params.type as EmailNotificationType,
        status: params.status as EmailNotificationStatus,
        error: params.error ?? null,
      },
    })
    .catch((err) => {
      console.error("[notification] Failed to write notification log:", err);
    });
}
