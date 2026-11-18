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
import { getMailboxesToPoll, getMailboxPollCursor, advanceMailboxPollCursor, type MailboxToPoll } from "@/lib/services/inbound-mailbox-service";
import { resolveOrCreateRequester } from "@/lib/services/requester-resolution-service";
import { UPLOAD_DIR, MAX_ATTACHMENT_SIZE_BYTES, isAllowedAttachmentMimeType, generateStoredFilename } from "@/lib/attachment-policy";
import { writeAttachmentFile } from "@/lib/attachment-storage-service";
import path from "path";
import fs from "fs/promises";

// Deliberately NOT NEXT_PUBLIC_* — this module is server-only (imports
// prisma directly), and a NEXT_PUBLIC_ var gets inlined as a literal string
// at `next build` time, everywhere it's referenced, client code or not. The
// Docker build stage never sees the real .env (see .dockerignore), so a
// NEXT_PUBLIC_ fallback here would permanently bake in "http://localhost:3000"
// regardless of what docker-compose.yml's env_file supplies at container
// runtime — exactly the bug this was changed to fix. A plain APP_URL is
// read fresh from process.env whenever this code actually runs, which is
// what every consumer here (building an email link) needs.
const APP_URL = process.env.APP_URL || "http://localhost:3000";
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
 *
 * Never marks a message read or moves it out of the Inbox — some users
 * only have Outlook access to these shared mailboxes, never this app, so
 * every email must stay exactly where Outlook delivered it, visibly
 * unread. "What's already been looked at" is tracked entirely via each
 * mailbox's own persisted MailboxPollCursor (receivedDateTime-based),
 * never via Outlook's isRead flag — see getMailboxPollCursor/
 * advanceMailboxPollCursor (inbound-mailbox-service.ts) and
 * microsoftGraph.getMessagesSince.
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

    let messages: Awaited<ReturnType<typeof microsoftGraph.getMessagesSince>> = [];
    const cursorBefore = await getMailboxPollCursor(mailbox.email);
    try {
      messages = await microsoftGraph.getMessagesSince(mailbox.email, cursorBefore.toISOString(), 50);
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

    // Tracks how far this mailbox's poll cursor should advance once the
    // batch below finishes — every message up to (and including) this one
    // was handled WITHOUT a processing error. Deliberately frozen the
    // moment a message fails (never advanced past it) so that message, and
    // everything chronologically after it in this same batch, is retried
    // on the next poll — the direct replacement for the old "leave it
    // unread so it's refetched" retry mechanism, now that Outlook's
    // read/unread state is no longer used for that at all. A message
    // already-successfully-handled-then-retried is always a safe no-op:
    // the existing messageId-based dedup below skips it again.
    let cursorAdvanceTo: Date | null = null;
    let stopAdvancingCursor = false;
    // Single shared exit point for every "this message is fully, successfully
    // handled" path below (loop-skip, duplicate-skip, create/append) — see
    // cursorAdvanceTo's own doc comment above for the full rule.
    const markHandled = (receivedDateTime: string) => {
      if (!stopAdvancingCursor) cursorAdvanceTo = new Date(receivedDateTime);
    };

    for (const message of messages) {
      let parsed: ParsedEmail | null = null;

      try {
        parsed = parseIncomingEmail(message);

        // ── Loop / auto-reply protection ──────────────────────────────────
        if (isLoopEmail(parsed)) {
          await logEmail(run.id, mailbox.email, parsed, "SKIPPED_LOOP");
          markHandled(message.receivedDateTime);
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
          markHandled(message.receivedDateTime);
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

        // Successfully handled (created or appended) — never marks the
        // message read or moves it; it stays in the Inbox, unread, exactly
        // as Outlook delivered it. See markHandled's own doc comment above.
        markHandled(message.receivedDateTime);
      } catch (err) {
        // One email failure must not abort the whole mailbox (or the whole
        // batch) — processing continues with the NEXT message. But this
        // mailbox's poll cursor must never advance past this failed
        // message, so it (and everything chronologically after it in this
        // batch) is retried on the next poll — the direct replacement for
        // the old "leave it unread" retry mechanism.
        stopAdvancingCursor = true;
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

    if (cursorAdvanceTo) {
      await advanceMailboxPollCursor(mailbox.email, cursorAdvanceTo);
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

/**
 * Idempotent: if a TicketMessage for this exact reply email ALREADY
 * exists — a RETRY after a previous attempt created the message but then
 * failed partway through saving its attachments — reuses it instead of
 * calling prisma.ticketMessage.create again, which would otherwise throw
 * a unique-constraint violation on emailMessageId. That violation is
 * caught by this function's own caller as `isUniqueConstraintViolation`
 * and classified "SKIPPED_DUPLICATE" — silently abandoning the retry
 * before it ever reached the attachments, same gap as
 * createPendingTicketFromEmail fixes for the new-thread path.
 *
 * Exported (in addition to its normal use from processInboundEmails)
 * purely so scripts/test-attachment-ingestion-failure-boundaries.ts can
 * exercise its idempotency and recoverable-failure-propagation behavior
 * directly, without mocking the entire Graph polling pipeline. No
 * behavior change from being exported.
 */
export async function appendEmailReply(
  parsed: ParsedEmail,
  ticket: { id: string; ticketNumber: number; title: string },
  userId: string
) {
  let msg = await prisma.ticketMessage.findUnique({
    where: { emailMessageId: parsed.messageId },
    include: {
      author: { select: { id: true, name: true, email: true, image: true, role: true } },
      attachments: true,
    },
  });

  if (!msg) {
    msg = await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: userId,
        // Normalized readable text, never parsed.bodyHtml — same BUG 1 fix as
        // acceptPendingTicket/createPendingTicketFromEmail: this is the reply
        // path (a follow-up email to an ALREADY-accepted ticket), the other
        // place a raw-HTML TicketMessage.body could previously be created.
        // See lib/email-ticket-parser.ts's ParsedEmail.bodyText doc comment.
        body: parsed.bodyText,
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
  }

  const summary = await saveEmailAttachments(parsed.attachments, ticket.id, msg.id, userId);
  if (summary.recoverableFailureCount > 0) {
    // RECOVERABLE (storage unavailable, or a write that failed
    // verification) — throw so the top-level caller's existing
    // stopAdvancingCursor retry-on-next-poll mechanism retries this exact
    // message; the reuse-existing-message logic above makes that retry
    // idempotent. Deliberately BEFORE the ticketHistory/publish steps
    // below — those only make sense once attachments are fully settled,
    // and will correctly run on the retry that finally succeeds.
    throw new Error(`Attachment storage was unavailable for ${summary.recoverableFailureCount} of ${parsed.attachments.length} attachment(s) on reply message ${msg.id} — this message will be retried on the next poll.`);
  }

  // Reached once attachments are fully settled without throwing. This is
  // NOT necessarily the first time these two steps run for this message:
  // the mailbox poll cursor (advanceMailboxPollCursor, in the top-level
  // caller) only advances ONCE PER BATCH, after every message in it has
  // been processed — not per-message. A process crash between this exact
  // point (this message's reply + history fully committed) and that
  // batch-level cursor commit means the NEXT poll re-fetches and
  // re-processes this SAME message from scratch: the findUnique at the
  // top of this function correctly reuses the existing TicketMessage, but
  // without the guard below, this would still create a SECOND
  // TicketHistory row for the exact same reply. emailMessageId is
  // `@unique` on TicketHistory (see schema.prisma) specifically to catch
  // that: a genuine duplicate hits a real DB unique-constraint violation
  // here, treated as "this reply's history was already written by an
  // earlier, crashed attempt" — skip the create, never throw.
  try {
    await prisma.ticketHistory.create({
      data: {
        ticketId: ticket.id,
        changedById: userId,
        type: "COMMENT_ADDED",
        description: `Email reply received from ${parsed.fromEmail}`,
        emailMessageId: parsed.messageId,
      },
    });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
  }

  // Notify anyone currently viewing the ticket. Deliberately OUTSIDE the
  // try/catch above and reached on BOTH the fresh-create path and the
  // caught-duplicate path above — never skipped on a retry. This closes a
  // DIFFERENT crash window from the one above: a process crash between
  // the history row committing and THIS call running would otherwise
  // permanently drop the notification for that reply (there is no
  // separate durable, replayable outbox for it to be re-delivered from —
  // ticketEventBus is explicitly in-process/ephemeral and
  // publishTicketListInvalidation is a content-free "something changed"
  // pulse, not a record of this specific event — see their own doc
  // comments), since the very next retry's history-create would hit the
  // unique constraint and, if it returned there instead of falling
  // through to here, would never reach this call again. Calling it again
  // on a retry that already notified is always safe: both of these are
  // idempotent-by-design, fire-and-forget signals to currently-connected
  // clients to refresh from the (already correct) database state, not a
  // one-shot delivery that duplicating would corrupt.
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

export type AttachmentSaveSummary = { savedCount: number; alreadyPresentCount: number; permanentlyRejectedCount: number; recoverableFailureCount: number };

/** Exported purely for scripts/test-attachment-ingestion-failure-boundaries.ts — see appendEmailReply's own doc comment. No behavior change. */
export async function saveEmailAttachments(
  attachments: Array<{ id: string; name: string; contentType: string; size: number; contentBytes: string }>,
  ticketId: string,
  messageId: string,
  uploadedById: string
): Promise<AttachmentSaveSummary> {
  const summary: AttachmentSaveSummary = { savedCount: 0, alreadyPresentCount: 0, permanentlyRejectedCount: 0, recoverableFailureCount: 0 };

  // Idempotency pre-check for a RETRY of this exact reply message — same
  // two-key scheme (and the same reasoning) as savePendingAttachments in
  // lib/services/pending-ticket-service.ts: sourceAttachmentId (the
  // Graph-sourced identity) for a row saved by the CURRENT code, with a
  // (originalName, size) fallback for a LEGACY row that predates the
  // sourceAttachmentId column (NULL on every row saved before that
  // additive migration ran, never backfilled) — otherwise a message
  // still mid-retry across that migration boundary would have its
  // already-saved legacy attachments duplicated on the very next retry.
  const existing = await prisma.ticketAttachment.findMany({ where: { messageId }, select: { sourceAttachmentId: true, originalName: true, size: true } });
  const alreadySavedById = new Set(existing.map((e) => e.sourceAttachmentId).filter((id): id is string => id !== null));
  const alreadySavedLegacyKey = new Set(existing.filter((e) => e.sourceAttachmentId === null).map((e) => `${e.originalName}\u0000${e.size}`));

  for (const att of attachments) {
    try {
      // Same policy (allowlist + real byte-length cap) as
      // savePendingAttachments in lib/services/pending-ticket-service.ts —
      // see its own comment for why this previously had no check at all.
      // These are PERMANENT rejections — retrying changes nothing.
      if (!isAllowedAttachmentMimeType(att.contentType)) {
        console.warn(`[email] Skipping attachment ${att.name} — disallowed MIME type ${att.contentType}`);
        summary.permanentlyRejectedCount++;
        continue;
      }

      const bytes = Buffer.from(att.contentBytes, "base64");
      if (bytes.length > MAX_ATTACHMENT_SIZE_BYTES) {
        console.warn(`[email] Skipping attachment ${att.name} — ${bytes.length} bytes exceeds the ${MAX_ATTACHMENT_SIZE_BYTES}-byte cap`);
        summary.permanentlyRejectedCount++;
        continue;
      }

      if (alreadySavedById.has(att.id) || alreadySavedLegacyKey.has(`${att.name}\u0000${bytes.length}`)) {
        summary.alreadyPresentCount++;
        continue;
      }

      const dir = path.join(UPLOAD_DIR, ticketId);
      const filename = generateStoredFilename(att.name);

      // writeAttachmentFile (lib/attachment-storage-service.ts) — shared
      // with every other attachment write path — verifies UPLOAD_DIR is a
      // durable mount before writing, and atomically publishes (never
      // overwrites). A failure here is RECOVERABLE (storage unavailable or
      // a write that failed verification) — counted as such so the caller
      // knows to retry this whole message later, never silently dropped.
      const writeResult = await writeAttachmentFile(bytes, dir, filename);
      if (!writeResult.ok) {
        console.error(`[email] Failed to save attachment ${att.name}: ${writeResult.reason}`);
        summary.recoverableFailureCount++;
        continue;
      }

      // Unlike the initial-message migration in acceptPendingTicket (fixed
      // to messageId: null — see its own comment), a REPLY's attachments
      // are correctly message-scoped here: they belong to this specific
      // reply, appear under this specific message bubble in the thread, and
      // there is no "ticket-level attachments" expectation for a reply the
      // way there is for the ticket's own initial creation.
      try {
        await prisma.ticketAttachment.create({
          data: {
            ticketId,
            messageId,
            uploadedById,
            filename,
            originalName: att.name,
            mimeType: att.contentType,
            size: writeResult.size,
            path: `/uploads/${ticketId}/${filename}`,
            sourceAttachmentId: att.id,
          },
        });
        summary.savedCount++;
      } catch (dbErr) {
        // Compensation: the file above was JUST published, in THIS SAME
        // call, at this EXACT path this function itself computed — never
        // any pre-existing attachment. Removing it leaves no dangling
        // reference, and a retry will attempt this attachment again (not
        // yet represented by any row, so the idempotency check above
        // won't skip it).
        await fs.unlink(path.join(dir, filename)).catch(() => {});
        console.error(`[email] Published attachment ${att.name} but the database record failed — removed the orphaned file:`, dbErr);
        summary.recoverableFailureCount++;
      }
    } catch (err) {
      console.error(`[email] Failed to save attachment ${att.name}:`, err);
      summary.recoverableFailureCount++;
    }
  }

  return summary;
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
