import { prisma } from "@/lib/prisma";
import { microsoftGraph } from "@/lib/microsoft-graph";
import {
  buildTicketReplyNotificationHtml,
  buildTicketClosedNotificationHtml,
  buildTicketCreatedNotificationHtml,
} from "@/lib/email-ticket-parser";
import { formatTicketNumber, truncate } from "@/lib/utils";
import { sendPushNotificationsToUser } from "@/lib/web-push";
import {
  EmailNotificationType,
  EmailNotificationStatus,
  PushNotificationType,
  PushNotificationStatus,
  Prisma,
} from "@prisma/client";

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

// ── Web Push: public reply ──────────────────────────────────────────────────
// The business event is "another user posted a public reply to the
// requester's ticket" — deliberately NOT gated by canManageTickets()/Role
// (unlike the email path above, which keeps its existing, more conservative
// gate untouched). This function independently re-derives eligibility from
// the message/ticket rows themselves (never trusts a caller-passed flag),
// mirroring how notifyRequesterReply above does its own
// direction/isInternal check rather than trusting the route.

export async function notifyTicketRequesterPublicReply(params: {
  ticketId: string;
  messageId: string;
}): Promise<void> {
  try {
    await notifyTicketRequesterPublicReplyImpl(params);
  } catch (err) {
    // Same final safety net as the CREATED/CLOSED email functions above —
    // every call site schedules this via next/server's after(), detached
    // from the response, so this must never surface as an unhandled
    // rejection there regardless of where the failure occurred.
    console.error(`[notification] notifyTicketRequesterPublicReply crashed for ticket ${params.ticketId}:`, err);
  }
}

async function notifyTicketRequesterPublicReplyImpl(params: { ticketId: string; messageId: string }): Promise<void> {
  const msg = await prisma.ticketMessage.findUnique({
    where: { id: params.messageId },
    select: { isInternal: true, authorId: true, body: true, author: { select: { name: true } } },
  });
  // Internal notes never notify the requester; a message with no resolved
  // author (e.g. a pure inbound-email-originated row) has no "another user"
  // to attribute the reply to.
  if (!msg || msg.isInternal || !msg.authorId) return;

  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    select: { id: true, requesterId: true },
  });
  if (!ticket) return;

  // The requester replying to their own ticket is not "another user posted
  // a public reply to my ticket" — never notify for that, and never
  // hardcode any Role-specific exception beyond this.
  if (msg.authorId === ticket.requesterId) return;

  // One fixed key per message, ever — a given TicketMessage is created
  // exactly once, so a retried/duplicate request for the same messageId
  // always collapses onto the same row.
  const eventKey = `ticket:${ticket.id}:reply:${params.messageId}`;
  const claim = await claimPushEvent({
    eventKey,
    ticketId: ticket.id,
    messageId: params.messageId,
    userId: ticket.requesterId,
    type: PushNotificationType.REPLY,
  });
  if (!claim.claimed) return;

  const authorName = msg.author?.name ?? "Someone";
  const title = "New reply on your ticket";
  const body = `${authorName}: ${truncate(msg.body, 100)}`;
  const link = `/tickets/${ticket.id}`;

  await deliverRequesterPush({ logId: claim.logId, userId: ticket.requesterId, title, body, link, ticketId: ticket.id });
}

// ── Web Push: terminal (open -> closed) transition ──────────────────────────
// Fired once per real non-terminal -> terminal TRANSITION, mirroring
// notifyRequesterClosed above — callers must only invoke this once they've
// confirmed `oldStatus.isClosed === false && newStatus.isClosed === true`
// for the write they just made. Unlike the email equivalent, this
// deliberately does NOT notify when the actor themselves caused the
// transition (actorId === requesterId) — a push telling someone "your
// ticket was closed" when THEY just closed it is noise, not information;
// the confirmation email (unchanged) still covers that case.

export async function notifyTicketRequesterTerminalTransition(params: {
  ticketId: string;
  actorId: string;
  statusName: string;
}): Promise<void> {
  try {
    await notifyTicketRequesterTerminalTransitionImpl(params);
  } catch (err) {
    console.error(`[notification] notifyTicketRequesterTerminalTransition crashed for ticket ${params.ticketId}:`, err);
  }
}

async function notifyTicketRequesterTerminalTransitionImpl(params: {
  ticketId: string;
  actorId: string;
  statusName: string;
}): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: params.ticketId },
    select: { id: true, ticketNumber: true, title: true, requesterId: true, closedAt: true },
  });
  if (!ticket) return;

  if (!ticket.closedAt) {
    // Should be unreachable — every call site sets closedAt in the same
    // write that led to this call, same invariant as notifyRequesterClosed.
    console.error(`[notification] notifyTicketRequesterTerminalTransition called for ticket ${ticket.id} with no closedAt set — skipping.`);
    return;
  }

  if (params.actorId === ticket.requesterId) return;

  // Scoped to THIS close transition via its own closedAt — see this file's
  // header note on eventKey format; a genuine reopen-then-reclose later
  // gets a new closedAt and is correctly allowed to send a new push.
  const eventKey = `ticket:${ticket.id}:terminal:${ticket.closedAt.toISOString()}`;
  const claim = await claimPushEvent({
    eventKey,
    ticketId: ticket.id,
    messageId: null,
    userId: ticket.requesterId,
    type: PushNotificationType.TERMINAL,
  });
  if (!claim.claimed) return;

  const ref = formatTicketNumber(ticket.ticketNumber);
  const title = "Your ticket has been closed";
  const body = `${ref} · ${ticket.title} is now ${params.statusName}`;
  const link = `/tickets/${ticket.id}`;

  await deliverRequesterPush({ logId: claim.logId, userId: ticket.requesterId, title, body, link, ticketId: ticket.id });
}

/**
 * Shared delivery tail for both push functions above: mirrors the existing
 * in-app Notification (bell) feed — deliberately created here, once, so
 * refactoring the reply push path can never leave a duplicate/orphaned
 * Notification row behind, and a terminal push gets the same in-app parity
 * reply already had — then sends the actual Web Push fan-out and resolves
 * the claim to a status that reflects what really happened:
 * SKIPPED (no subscriptions to deliver to / push not configured), SENT (at
 * least one subscription received it), or FAILED (subscriptions existed but
 * every delivery attempt failed). A push provider failure is caught and
 * recorded, never rethrown — the caller's ticket operation has already
 * committed by the time this runs (every call site fires it only via
 * after()), so a push failure must never look like anything went wrong with
 * the ticket action itself.
 */
async function deliverRequesterPush(params: {
  logId: string;
  userId: string;
  title: string;
  body: string;
  link: string;
  ticketId: string;
}): Promise<void> {
  try {
    await prisma.notification.create({
      data: { userId: params.userId, title: params.title, body: params.body, link: params.link },
    });
  } catch (err) {
    // Non-fatal — the in-app bell feed is a nice-to-have alongside the real
    // push; a failure here must not stop the push attempt below.
    console.error(`[notification] Failed to create in-app notification for ticket ${params.ticketId}:`, err);
  }

  try {
    const result = await sendPushNotificationsToUser(params.userId, {
      title: params.title,
      body: params.body,
      link: params.link,
    });
    if (result.subscriptionCount === 0) {
      await resolvePushClaim(params.logId, "SKIPPED");
    } else if (result.sentCount > 0) {
      await resolvePushClaim(params.logId, "SENT");
    } else {
      await resolvePushClaim(params.logId, "FAILED", "All push deliveries failed");
    }
  } catch (err) {
    // sendPushNotificationsToUser itself never throws (Promise.allSettled
    // internally) — this catch is defensive-only, same reasoning as the
    // email try/catch blocks above.
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[notification] Failed to send push for ticket ${params.ticketId}:`, error);
    await resolvePushClaim(params.logId, "FAILED", error);
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

// ── Idempotent claim/resolve for Web Push events (eventKey-backed) ─────────
// Exact same atomic-INSERT-as-claim architecture as claimEvent/resolveClaim
// above (see that pair's doc comment for the full TOCTOU-race reasoning) —
// a sibling implementation over PushNotificationLog instead of
// EmailNotificationLog, since push events are keyed by userId, not
// recipientEmail, and REPLY push events (unlike REPLY emails) DO need this
// same-message-collapses-onto-one-row guarantee.

async function claimPushEvent(params: {
  eventKey: string;
  ticketId: string;
  messageId: string | null;
  userId: string;
  type: PushNotificationType;
}): Promise<{ claimed: true; logId: string } | { claimed: false }> {
  try {
    const row = await prisma.pushNotificationLog.create({
      data: {
        eventKey: params.eventKey,
        ticketId: params.ticketId,
        messageId: params.messageId,
        userId: params.userId,
        type: params.type,
        status: PushNotificationStatus.PENDING,
      },
      select: { id: true },
    });
    return { claimed: true, logId: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Another call (concurrent request, application-level retry, or a
      // second status-mutation path racing the same transition) already
      // owns this eventKey — nothing more to do here.
      return { claimed: false };
    }
    throw err;
  }
}

async function resolvePushClaim(logId: string, status: "SENT" | "FAILED" | "SKIPPED", error?: string): Promise<void> {
  await prisma.pushNotificationLog
    .update({
      where: { id: logId },
      data: { status: status as PushNotificationStatus, error: error ?? null },
    })
    .catch((err) => {
      console.error("[notification] Failed to update push notification log:", err);
    });
}
