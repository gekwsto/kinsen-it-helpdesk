import { prisma } from "@/lib/prisma";
import { microsoftGraph } from "@/lib/microsoft-graph";
import {
  parseIncomingEmail,
  buildReplyNotificationHtml,
  type ParsedEmail,
} from "@/lib/email-ticket-parser";
import { formatTicketNumber } from "@/lib/utils";
import { publishTicketEvent } from "@/lib/realtime/publisher";
import { EmailLogAction, Prisma } from "@prisma/client";
import { matchDepartmentForRecipients, createPendingTicketFromEmail } from "@/lib/services/pending-ticket-service";
import { getMailboxesToPoll, type MailboxToPoll } from "@/lib/services/inbound-mailbox-service";
import { resolveOrCreateRequester } from "@/lib/services/requester-resolution-service";
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

/** Per-mailbox breakdown persisted on EmailPollRun.mailboxResults — see that column's schema comment. */
interface MailboxPollResult {
  mailbox: string;
  kind: MailboxToPoll["kind"];
  departmentId: string | null;
  departmentName: string | null;
  ok: boolean;
  error: string | null;
  fetched: number;
  created: number;
  appended: number;
  skipped: number;
  errors: number;
}

/** True for a Prisma unique-constraint violation (P2002) — used to treat a race between two overlapping poll runs as a safe duplicate-skip instead of a hard error. */
function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Polls EVERY mailbox returned by getMailboxesToPoll() — the central
 * support mailbox plus every active department's own inboundEmail — each
 * fully independently: a Graph failure fetching one mailbox (wrong address,
 * missing permission, a distribution-only address that isn't a real
 * mailbox, etc.) is caught, recorded against THAT mailbox only, and never
 * prevents any other mailbox (including the central one) from being
 * processed in the same run. See lib/services/inbound-mailbox-service.ts
 * for the mailbox-discovery/dedup rules and MailboxToPoll's `kind`, which
 * drives routing below.
 */
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
  const mailboxResults: MailboxPollResult[] = [];

  let mailboxes: MailboxToPoll[];
  try {
    mailboxes = await getMailboxesToPoll();
  } catch (err) {
    // Only a genuinely infrastructural failure (e.g. the database itself is
    // unreachable) reaches here — a single mailbox's Graph failure never
    // does, see the per-mailbox loop below. Preserves the pre-existing
    // "close the run record, then propagate" behavior for this class of
    // failure.
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.emailPollRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), errors: 1, lastError: msg, succeeded: false },
    });
    throw err;
  }

  for (const mailbox of mailboxes) {
    const mailboxResult: MailboxPollResult = {
      mailbox: mailbox.email,
      kind: mailbox.kind,
      departmentId: mailbox.departmentId,
      departmentName: mailbox.departmentName,
      ok: true,
      error: null,
      fetched: 0,
      created: 0,
      appended: 0,
      skipped: 0,
      errors: 0,
    };

    let messages: Awaited<ReturnType<typeof microsoftGraph.getUnreadMessages>> = [];
    try {
      messages = await microsoftGraph.getUnreadMessages(mailbox.email, 50);
      mailboxResult.fetched = messages.length;
    } catch (err) {
      // This mailbox is inaccessible/misconfigured — record it and move on
      // to the NEXT mailbox. Never aborts polling of any other mailbox.
      const msg = err instanceof Error ? err.message : String(err);
      mailboxResult.ok = false;
      mailboxResult.error = msg;
      mailboxResult.errors = 1;
      lastError = msg;
      errors++;
      console.error(`[email] Failed to fetch messages from mailbox ${mailbox.email}:`, err);
      mailboxResults.push(mailboxResult);
      continue;
    }

    for (const message of messages) {
      let parsed: ParsedEmail | null = null;

      try {
        parsed = parseIncomingEmail(message);

        // ── Loop / auto-reply protection ──────────────────────────────────
        if (isLoopEmail(parsed)) {
          await logEmail(run.id, mailbox.email, parsed, "SKIPPED_LOOP");
          await microsoftGraph.markAsRead(mailbox.email, message.id);
          skipped++;
          mailboxResult.skipped++;
          continue;
        }

        // ── Message-ID deduplication ─────────────────────────────────────
        // Checks both tables a message could already exist under: a reply
        // already appended to a real Ticket (TicketMessage), or a still-
        // pending (or already resolved) PendingTicket from an earlier poll
        // run — or from a DIFFERENT mailbox in THIS SAME run, since the
        // same internetMessageId could in principle be visible through more
        // than one configured delivery path (e.g. a message both delivered
        // directly to a department mailbox AND forwarded/cc'd into the
        // central one).
        const [duplicateMessage, duplicatePending] = await Promise.all([
          prisma.ticketMessage.findFirst({ where: { emailMessageId: parsed.messageId }, select: { id: true } }),
          prisma.pendingTicket.findFirst({ where: { emailMessageId: parsed.messageId }, select: { id: true } }),
        ]);
        if (duplicateMessage || duplicatePending) {
          await logEmail(run.id, mailbox.email, parsed, "SKIPPED_DUPLICATE");
          await microsoftGraph.markAsRead(mailbox.email, message.id);
          skipped++;
          mailboxResult.skipped++;
          continue;
        }

        // ── Route: append to an already-accepted ticket, or create a pending ticket ──
        // Replies to a real, already-accepted Ticket (subject carries its
        // number) still append directly — no pending step for those. Every
        // other new thread now creates a PendingTicket, never a Ticket
        // directly; a human must Accept it via /tickets/pending.
        //
        // Department resolution is deterministic per mailbox.kind:
        //   - "department": this message was fetched directly from a
        //     specific department's own configured mailbox — route straight
        //     to it, never re-derived from (and never overridden by) Graph
        //     `toRecipients`, which Exchange rules/aliases/forwarding can
        //     rewrite.
        //   - "central": unchanged, existing recipient-based matching — this
        //     is what keeps aliases/forwarding that ultimately deliver into
        //     the central mailbox working exactly as before.
        let ticketId: string | null = null;
        let duplicateRace = false;

        if (parsed.existingTicketNumber !== null) {
          const ticket = await prisma.ticket.findUnique({
            where: { ticketNumber: parsed.existingTicketNumber },
            select: { id: true, ticketNumber: true, title: true },
          });

          if (ticket) {
            const user = await findOrCreateRequesterForReply(parsed);
            try {
              await appendEmailReply(parsed, ticket, user.id);
            } catch (err) {
              if (!isUniqueConstraintViolation(err)) throw err;
              duplicateRace = true;
            }
            if (duplicateRace) {
              await logEmail(run.id, mailbox.email, parsed, "SKIPPED_DUPLICATE");
              skipped++;
              mailboxResult.skipped++;
            } else {
              ticketId = ticket.id;
              await logEmail(run.id, mailbox.email, parsed, "APPENDED_REPLY", ticketId);
              appended++;
              mailboxResult.appended++;
            }
          } else {
            // Ticket ref in subject but ticket not found — create a pending ticket
            const department = mailbox.kind === "department" ? { id: mailbox.departmentId! } : await matchDepartmentForRecipients(parsed.toEmails);
            try {
              const pendingTicket = await createPendingTicketFromEmail(parsed, department);
              await logEmail(run.id, mailbox.email, parsed, "CREATED_TICKET", pendingTicket.id);
              created++;
              mailboxResult.created++;
            } catch (err) {
              if (!isUniqueConstraintViolation(err)) throw err;
              await logEmail(run.id, mailbox.email, parsed, "SKIPPED_DUPLICATE");
              skipped++;
              mailboxResult.skipped++;
            }
          }
        } else {
          const department = mailbox.kind === "department" ? { id: mailbox.departmentId! } : await matchDepartmentForRecipients(parsed.toEmails);
          try {
            const pendingTicket = await createPendingTicketFromEmail(parsed, department);
            await logEmail(run.id, mailbox.email, parsed, "CREATED_TICKET", pendingTicket.id);
            created++;
            mailboxResult.created++;
          } catch (err) {
            if (!isUniqueConstraintViolation(err)) throw err;
            await logEmail(run.id, mailbox.email, parsed, "SKIPPED_DUPLICATE");
            skipped++;
            mailboxResult.skipped++;
          }
        }

        // ── Move processed email — in the EXACT mailbox it was fetched from ──
        await microsoftGraph.markAsRead(mailbox.email, message.id);
        await microsoftGraph.moveMessage(mailbox.email, message.id, "Processed");
      } catch (err) {
        // One email failure must not abort the whole mailbox (or the whole
        // batch). Leave the email UNREAD so it is retried on the next poll.
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = errMsg;
        errors++;
        mailboxResult.errors++;

        // Best-effort log — swallow any secondary DB error
        await prisma.emailProcessingLog
          .create({
            data: {
              runId: run.id,
              mailbox: mailbox.email,
              messageId: parsed?.messageId ?? null,
              fromEmail: parsed?.fromEmail ?? null,
              subject: parsed?.subject ?? null,
              action: "FAILED",
              error: errMsg,
            },
          })
          .catch(() => {});

        console.error(`[email] Failed to process message ${message.id} from mailbox ${mailbox.email}:`, err);
      }
    }

    mailboxResults.push(mailboxResult);
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
      mailboxResults: mailboxResults as unknown as Prisma.InputJsonValue,
    },
  });

  return { created, appended, skipped, errors, runId: run.id };
}

// ── Logging helper ────────────────────────────────────────────────────────────

async function logEmail(
  runId: string,
  mailbox: string,
  parsed: ParsedEmail,
  action: EmailLogAction,
  ticketId?: string | null
) {
  await prisma.emailProcessingLog.create({
    data: {
      runId,
      mailbox,
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

// ── Find or create the requester for a reply to an already-accepted ticket ────
// New-thread requester resolution now happens inside
// createPendingTicketFromEmail (lib/services/pending-ticket-service.ts) — this
// copy stays only for the append-reply path, which still writes a
// TicketMessage.authorId directly against a real Ticket.

async function findOrCreateRequesterForReply(parsed: ParsedEmail): Promise<{ id: string }> {
  const requester = await resolveOrCreateRequester(parsed.fromEmail, parsed.fromName || undefined);
  return { id: requester.id };
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

// ── Admin: create synthetic test pending ticket ──────────────────────────────
// Exercises the exact same pending-ticket creation path real inbound email
// now uses (matchDepartmentForRecipients + createPendingTicketFromEmail) —
// no more direct-to-Ticket shortcut, so this diagnostic stays honest about
// what actually happens on a real inbound message.

export async function createTestEmailTicket(): Promise<{
  id: string;
  subject: string;
}> {
  const now = new Date();
  const parsed: ParsedEmail = {
    messageId: `test-${now.getTime()}@test.local`,
    conversationId: `test-conv-${now.getTime()}`,
    subject: `Test Email Ticket — ${now.toISOString()}`,
    fromEmail: "test-sender@example.com",
    fromName: "Test Sender (Admin Test)",
    bodyHtml:
      "<p>This is a <strong>test pending ticket</strong> created via the admin email diagnostics panel to verify the email-to-pending-ticket pipeline.</p>",
    bodyText: "This is a test pending ticket created via the admin email diagnostics panel.",
    existingTicketNumber: null,
    internetMessageHeaders: [],
    attachments: [],
    receivedAt: now,
    toEmails: [],
  };

  const department = await matchDepartmentForRecipients(parsed.toEmails);
  const pendingTicket = await createPendingTicketFromEmail(parsed, department);
  return { id: pendingTicket.id, subject: parsed.subject };
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
