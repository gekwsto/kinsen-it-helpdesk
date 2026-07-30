import { prisma } from "@/lib/prisma";
import { microsoftGraph } from "@/lib/microsoft-graph";
import {
  buildTicketReplyNotificationHtml,
  buildTicketClosedNotificationHtml,
  buildTicketCreatedNotificationHtml,
} from "@/lib/email-ticket-parser";
import { formatTicketNumber } from "@/lib/utils";
import { EmailNotificationType, EmailNotificationStatus, Prisma } from "@prisma/client";

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

// TEMPORARY development-only diagnostic tracing for the "creation email
// never arrived" investigation — never logs secrets/tokens (only eventKey,
// type, recipient, claim outcome, and the Graph attempt's success/failure),
// and is silent outside development so it never becomes production log
// noise. Safe to remove once the underlying issue (env config, not this
// code) is resolved and confirmed end-to-end.
function notifyDiag(step: string, data: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  console.log(`[notify-diag] ${step}`, JSON.stringify(data));
}

/** Central recipient/loop guard for every lifecycle notification — never re-implemented at a call site. */
function isNotifiableEmail(email: string): boolean {
  const lower = email.toLowerCase();
  if (lower === SUPPORT_EMAIL) return false;
  const localPart = lower.split("@")[0];
  return !NO_REPLY_LOCAL_PARTS.has(localPart);
}

const LOOP_PREVENTION_HEADERS = (ref: string) => [
  { name: "X-Ticket-Number", value: ref },
  { name: "Auto-Submitted", value: "auto-generated" },
  { name: "X-Auto-Response-Suppress", value: "All" },
];

// ── Reply notification (unchanged) ──────────────────────────────────────────

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
        internetMessageHeaders: LOOP_PREVENTION_HEADERS(ref),
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

// ── Created notification ────────────────────────────────────────────────────
// Fired exactly once per ticket, only after a real Ticket row exists with a
// real ticketNumber — never for a PendingTicket that hasn't been accepted
// yet. Both real creation paths (POST /api/tickets, and acceptPendingTicket
// once a PendingTicket is accepted) call this the same way, with just the
// new ticket's id — this function does its own fetch, so neither caller
// needs to build HTML or touch Microsoft Graph directly.

export async function notifyRequesterCreated(params: { ticketId: string }): Promise<void> {
  try {
    await notifyRequesterCreatedImpl(params);
  } catch (err) {
    // Final safety net — claimEvent itself can throw on a genuine
    // (non-P2002) database error, which happens BEFORE any log row exists
    // to resolve to FAILED. Every caller of this function schedules it via
    // next/server's after(), detached from the response — this guarantees
    // it never surfaces as an unhandled rejection there regardless of where
    // the failure occurred.
    console.error(`[notification] notifyRequesterCreated crashed for ticket ${params.ticketId}:`, err);
  }
}

async function notifyRequesterCreatedImpl(params: { ticketId: string }): Promise<void> {
  notifyDiag("notifyRequesterCreated:enter", { ticketId: params.ticketId });

  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    include: {
      requester: { select: { email: true, name: true } },
      status: { select: { name: true } },
    },
  });
  if (!ticket) {
    notifyDiag("notifyRequesterCreated:ticket-not-found", { ticketId: params.ticketId });
    return;
  }

  const recipientEmail = ticket.requester.email;
  // One fixed key per ticket — a ticket is created exactly once, ever, so
  // this event can never legitimately recur; a retry/duplicate call always
  // collapses onto the same DB row (see claimEvent).
  const eventKey = `ticket:${ticket.id}:created`;

  notifyDiag("notifyRequesterCreated:before-claim", { eventKey, type: "CREATED", recipientEmail });
  const claim = await claimEvent({
    eventKey,
    ticketId: ticket.id,
    messageId: null,
    recipientEmail,
    type: "CREATED",
  });
  notifyDiag("notifyRequesterCreated:after-claim", { eventKey, claimed: claim.claimed, logId: claim.claimed ? claim.logId : null });
  if (!claim.claimed) return; // already sent/failed/skipped, or another concurrent call owns it right now

  if (!isNotifiableEmail(recipientEmail)) {
    notifyDiag("notifyRequesterCreated:skipped", { eventKey, recipientEmail, reason: "isNotifiableEmail=false" });
    await resolveClaim(claim.logId, "SKIPPED");
    return;
  }

  const ref = formatTicketNumber(ticket.ticketNumber);
  const html = buildTicketCreatedNotificationHtml({
    ticketId: ticket.id,
    ticketNumber: ticket.ticketNumber,
    ticketTitle: ticket.title,
    requesterName: ticket.requester.name,
    statusName: ticket.status.name,
    appUrl: APP_URL,
  });

  notifyDiag("notifyRequesterCreated:graph-attempt-start", { eventKey, recipientEmail, subject: `[${ref}] ${ticket.title}` });
  try {
    await microsoftGraph.sendMail({
      message: {
        subject: `[${ref}] ${ticket.title}`,
        body: { contentType: "HTML", content: html },
        toRecipients: [
          {
            emailAddress: {
              address: recipientEmail,
              name: ticket.requester.name ?? undefined,
            },
          },
        ],
        internetMessageHeaders: LOOP_PREVENTION_HEADERS(ref),
      },
    });
    notifyDiag("notifyRequesterCreated:graph-attempt-ok", { eventKey });
    await resolveClaim(claim.logId, "SENT");
  } catch (err) {
    // The Ticket itself is already fully created and committed by the time
    // this runs (every call site fires this only after its own DB write
    // succeeds) — a Graph failure here must never look like a ticket
    // creation failure to the caller. Logged, not rethrown: see the
    // eventKey doc comment in schema.prisma and the call sites' use of
    // next/server's after() for why this is safe to run detached from the
    // response without losing the attempt or leaving an unhandled rejection.
    const error = err instanceof Error ? err.message : String(err);
    notifyDiag("notifyRequesterCreated:graph-attempt-failed", { eventKey, error });
    console.error(`[notification] Failed to send created email for ticket ${ticket.id}:`, error);
    await resolveClaim(claim.logId, "FAILED", error);
  }
}

// ── Closed notification ───────────────────────────────────────────────────────
// Fired once per real open->closed TRANSITION, never merely because the
// current status happens to be closed — callers are responsible for only
// invoking this when they've confirmed `oldStatus.isClosed === false &&
// newStatus.isClosed === true` for the write they just made (every call
// site does this explicitly, right before calling this function). The
// eventKey below is itself also transition-scoped (via the ticket's own
// persisted closedAt), so even a caller that got this wrong, or two
// concurrent callers racing the same transition, still can't produce two
// emails for the same close.

export async function notifyRequesterClosed(params: {
  ticketId: string;
  statusName: string;
  closingMessage?: string;
}): Promise<void> {
  try {
    await notifyRequesterClosedImpl(params);
  } catch (err) {
    // Same final safety net as notifyRequesterCreated above.
    console.error(`[notification] notifyRequesterClosed crashed for ticket ${params.ticketId}:`, err);
  }
}

async function notifyRequesterClosedImpl(params: {
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

  if (!ticket.closedAt) {
    // Should be unreachable — every call site sets closedAt in the same
    // write that led to this call. Logged rather than guessed at: there is
    // no safe, still-idempotent eventKey to fall back to without it.
    console.error(`[notification] notifyRequesterClosed called for ticket ${ticket.id} with no closedAt set — skipping.`);
    return;
  }

  const recipientEmail = ticket.requester.email;
  // Scoped to THIS close transition via its own closedAt — a genuine
  // reopen-then-reclose later gets a new closedAt and therefore a new
  // eventKey, correctly allowed to send its own new email; a retry of the
  // SAME transition reads back the SAME closedAt and collapses onto the
  // same row.
  const eventKey = `ticket:${ticket.id}:closed:${ticket.closedAt.toISOString()}`;

  const claim = await claimEvent({
    eventKey,
    ticketId: ticket.id,
    messageId: null,
    recipientEmail,
    type: "CLOSED",
  });
  if (!claim.claimed) return;

  if (!isNotifiableEmail(recipientEmail)) {
    await resolveClaim(claim.logId, "SKIPPED");
    return;
  }

  const ref = formatTicketNumber(ticket.ticketNumber);
  const html = buildTicketClosedNotificationHtml({
    ticketId: ticket.id,
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
        internetMessageHeaders: LOOP_PREVENTION_HEADERS(ref),
      },
    });
    await resolveClaim(claim.logId, "SENT");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[notification] Failed to send closed email for ticket ${ticket.id}:`, error);
    await resolveClaim(claim.logId, "FAILED", error);
  }
}

// ── Idempotent claim/resolve for CREATED/CLOSED (eventKey-backed) ──────────
//
// Why this and not "findFirst then create": a findFirst-before-create check
// at the application level has a TOCTOU race — two concurrent requests can
// both observe "no existing log row" before either one writes, and both
// proceed to send. The actual guard here is the unique constraint on
// EmailNotificationLog.eventKey: the INSERT itself (status: PENDING) is the
// atomic ownership claim. Whichever caller's INSERT lands first wins;
// everyone else gets a unique-constraint violation (P2002) and backs off
// without sending anything. The row is then updated in place to its final
// SENT/FAILED/SKIPPED status once the actual attempt resolves.

async function claimEvent(params: {
  eventKey: string;
  ticketId: string;
  messageId: string | null;
  recipientEmail: string;
  type: EmailNotificationType;
}): Promise<{ claimed: true; logId: string } | { claimed: false }> {
  try {
    const row = await prisma.emailNotificationLog.create({
      data: {
        eventKey: params.eventKey,
        ticketId: params.ticketId,
        messageId: params.messageId,
        recipientEmail: params.recipientEmail,
        type: params.type,
        status: EmailNotificationStatus.PENDING,
      },
      select: { id: true },
    });
    return { claimed: true, logId: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Another call (a genuine concurrent request, an application-level
      // retry, or this exact event having already been fully processed
      // earlier) already owns this eventKey — nothing more to do here.
      return { claimed: false };
    }
    throw err;
  }
}

async function resolveClaim(logId: string, status: "SENT" | "FAILED" | "SKIPPED", error?: string): Promise<void> {
  await prisma.emailNotificationLog
    .update({
      where: { id: logId },
      data: { status: status as EmailNotificationStatus, error: error ?? null },
    })
    .catch((err) => {
      console.error("[notification] Failed to update notification log:", err);
    });
}

// ── Internal logging helper (REPLY only — CREATED/CLOSED use claimEvent/resolveClaim above) ──

async function writeLog(params: {
  ticketId: string;
  messageId: string | null;
  recipientEmail: string;
  type: "REPLY";
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
