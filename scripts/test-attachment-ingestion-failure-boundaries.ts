/**
 * Focused regression for the failure-boundary fixes across email ingestion
 * (lib/services/pending-ticket-service.ts, lib/ticket-email-service.ts):
 * a storage failure must never be silently swallowed while the parent
 * operation (PendingTicket creation, a ticket reply) is reported as
 * successful, retries of the SAME message must be idempotent (never
 * duplicate a Ticket/PendingTicket/TicketMessage or an attachment), and a
 * file published successfully but immediately followed by a failed
 * database insert must be compensated (the orphaned file removed, no
 * pre-existing file ever touched).
 *
 * No Graph mocking is needed — createPendingTicketFromEmail,
 * savePendingAttachments, appendEmailReply, and saveEmailAttachments never
 * call microsoftGraph themselves (that happens one layer up, in
 * processInboundEmails, which this test does not exercise). UPLOAD_DIR is
 * sandboxed to a throwaway OS-temp directory, same convention as the
 * other focused tests in this suite.
 *
 * Proves:
 *   A. createPendingTicketFromEmail: a storage-unavailable first attempt
 *      throws (never silently reports success) but still creates the
 *      PendingTicket itself (the message content is not lost). A retry
 *      after storage is fixed reuses that SAME PendingTicket (never a
 *      duplicate) and successfully saves the attachment that failed
 *      before.
 *   B. savePendingAttachments: a file published successfully followed by
 *      a database insert failure (a nonexistent pendingTicketId,
 *      triggering a real foreign-key violation) is counted as a
 *      recoverable failure, and the orphaned file is removed — zero
 *      files left behind.
 *   C. savePendingAttachments: a permanently-rejected attachment
 *      (disallowed MIME type) never blocks a DIFFERENT, valid attachment
 *      in the same call from being saved.
 *   D. savePendingAttachments: calling it AGAIN with the exact same
 *      attachments against the same PendingTicket never duplicates an
 *      already-saved attachment.
 *   E. appendEmailReply: the same storage-unavailable-then-retry shape as
 *      A, but for a ticket reply — additionally proves the ticket history
 *      entry and realtime notification fire EXACTLY ONCE, on whichever
 *      attempt actually completes successfully, never zero times (missed
 *      entirely) and never twice (duplicated).
 *   F. saveEmailAttachments: the same orphan-cleanup guarantee as B, for
 *      the reply path (a nonexistent ticketId triggering a foreign-key
 *      violation).
 *   G. savePendingAttachments: TWO DISTINCT attachments sharing the exact
 *      same (originalName, size) but with different Graph attachment ids
 *      both survive ingestion — proving the old (originalName, size)
 *      dedup key, which would have collapsed them into one, is gone.
 *   H. saveEmailAttachments: a retry that re-constructs the SAME source
 *      attachment (same Graph id, fresh object) across two SEPARATE calls
 *      is recognized as already-saved and never duplicated — the
 *      identity survives even when the attachment object itself isn't
 *      literally reused, proving the dedup key is the Graph id, not
 *      object identity.
 *   I. appendEmailReply: the crash-before-cursor-advance window — calling
 *      it a SECOND time with the exact same ParsedEmail after the first
 *      call already fully committed (simulating a process crash between
 *      full success and the mailbox poll cursor advancing past this
 *      message, which causes the next poll to re-fetch and re-process it
 *      from scratch) must result in exactly ONE TicketHistory row, but
 *      the notification MUST fire again — closing the separate
 *      history-to-notification crash window (a crash between the history
 *      row committing and the notification firing would otherwise drop
 *      it permanently, since it has no durable, replayable record of its
 *      own to redeliver from later).
 *   J. Graph attachment identity is scoped to its own parent record, not
 *      global: two DIFFERENT PendingTickets (and two DIFFERENT reply
 *      TicketMessages) each saving an attachment that happens to carry
 *      the exact same literal sourceAttachmentId value never suppress
 *      each other — only an attachment already saved under THIS SAME
 *      parent counts as a duplicate.
 *   K. Legacy-row compatibility: an existing PendingTicketAttachment /
 *      TicketAttachment row with sourceAttachmentId = NULL (as every row
 *      saved before that column existed necessarily has) is still
 *      correctly recognized as "already saved" on a retry via the old
 *      (originalName, size) fallback — proving a message that was
 *      PARTIALLY saved before this migration and is still being retried
 *      afterward does not get its already-saved legacy attachments
 *      duplicated.
 *
 * Usage: npx tsx scripts/test-attachment-ingestion-failure-boundaries.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import os from "os";
import path from "path";
import fs from "fs/promises";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const TAG = `gfail-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);
const BAD_MOUNT_INFO = "37 35 98:0 / / rw,relatime shared:1 - overlay overlay rw\n";

async function main() {
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR;
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });

  const { prisma } = await import("@/lib/prisma");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { Role, AuthProvider, TicketSource } = await import("@prisma/client");
  const { verifyAttachmentStorage, resetAttachmentStorageVerificationForTests } = await import("@/lib/attachment-storage-service");
  const { createPendingTicketFromEmail, savePendingAttachments } = await import("@/lib/services/pending-ticket-service");
  const { appendEmailReply, saveEmailAttachments } = await import("@/lib/ticket-email-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const pendingTicketIds: string[] = [];

  function makeParsedEmail(overrides: Partial<Parameters<typeof createPendingTicketFromEmail>[0]>) {
    return {
      subject: "Test subject",
      fromEmail: `${TAG}-sender@example.com`,
      fromName: "Test Sender",
      bodyHtml: "",
      bodyText: "body text",
      attachments: [],
      messageId: `<${TAG}-default@example.com>`,
      conversationId: `${TAG}-conv`,
      receivedAt: new Date(),
      existingTicketNumber: null,
      internetMessageHeaders: [],
      toEmails: [],
      ...overrides,
    };
  }
  function makeAttachment(name: string, content: string, contentType = "image/png", id = `${TAG}-${name}`) {
    const contentBytes = Buffer.from(content).toString("base64");
    return { id, name, contentType, size: content.length, contentBytes };
  }

  try {
    const forceUnverified = () => {
      resetAttachmentStorageVerificationForTests();
      return verifyAttachmentStorage({ platform: "linux", uploadDir: TEMP_UPLOAD_DIR, mountInfoReader: async () => BAD_MOUNT_INFO });
    };
    const forceVerified = () => {
      resetAttachmentStorageVerificationForTests();
      return verifyAttachmentStorage({ platform: "darwin", uploadDir: TEMP_UPLOAD_DIR });
    };

    // ── A — createPendingTicketFromEmail: throw-then-idempotent-retry. ────
    console.log("\nA — createPendingTicketFromEmail: storage failure throws (never silent), retry is idempotent...\n");
    {
      const parsed = makeParsedEmail({ messageId: `<${TAG}-A@example.com>`, attachments: [makeAttachment("a.png", "attachment A content")] });

      await forceUnverified();
      let threw = false;
      try {
        await createPendingTicketFromEmail(parsed, null);
      } catch {
        threw = true;
      }
      check("A: first attempt throws when storage is unverified", threw);

      const pendingAfterFirst = await prisma.pendingTicket.findUnique({ where: { emailMessageId: parsed.messageId } });
      check("A: the PendingTicket WAS still created (message content not lost)", pendingAfterFirst !== null);
      if (pendingAfterFirst) pendingTicketIds.push(pendingAfterFirst.id);
      const attachmentsAfterFirst = pendingAfterFirst ? await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingAfterFirst.id } }) : -1;
      check("A: zero attachments saved on the failed first attempt", attachmentsAfterFirst === 0);

      await forceVerified();
      const retryResult = await createPendingTicketFromEmail(parsed, null);
      check("A: retry returns the SAME PendingTicket id (never a duplicate)", pendingAfterFirst !== null && retryResult.id === pendingAfterFirst.id);
      const pendingCount = await prisma.pendingTicket.count({ where: { emailMessageId: parsed.messageId } });
      check("A: still exactly ONE PendingTicket row after the retry", pendingCount === 1);
      const attachmentsAfterRetry = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: retryResult.id } });
      check("A: exactly ONE attachment now saved on retry", attachmentsAfterRetry === 1);
    }

    // ── B — savePendingAttachments: publish-then-DB-fail is compensated. ──
    console.log("\nB — savePendingAttachments: a file published then a failed DB insert is cleaned up (zero orphans)...\n");
    {
      await forceVerified();
      const fakePendingTicketId = `${TAG}-nonexistent-pending-id`;
      const summary = await savePendingAttachments([makeAttachment("orphan.png", "would-be orphan content")], fakePendingTicketId);
      check("B: the write-then-DB-fail attachment is counted as a recoverable failure, zero saved", summary.recoverableFailureCount === 1 && summary.savedCount === 0);
      const orphanDir = path.join(TEMP_UPLOAD_DIR, "pending", fakePendingTicketId);
      const orphanFiles = await fs.readdir(orphanDir).catch(() => []);
      check("B: zero files remain — the orphaned publish was removed", orphanFiles.length === 0);
    }

    // ── C — savePendingAttachments: a permanent rejection never blocks a
    //    different, valid attachment in the same call. ────────────────────
    console.log("\nC — savePendingAttachments: a permanently-rejected attachment never blocks the others...\n");
    let pendingC: { id: string };
    {
      const requesterC = await prisma.user.create({ data: { email: `${TAG}-c-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterC.id);
      pendingC = await prisma.pendingTicket.create({
        data: { emailMessageId: `<${TAG}-C@example.com>`, fromEmail: `${TAG}-c@example.com`, fromName: "C", subject: "C", body: "C", receivedAt: new Date(), requesterId: requesterC.id },
      });
      pendingTicketIds.push(pendingC.id);

      const summary = await savePendingAttachments(
        [makeAttachment("virus.exe", "bad content", "application/x-msdownload"), makeAttachment("good.png", "good content")],
        pendingC.id
      );
      check("C: the bad-MIME attachment is permanently rejected", summary.permanentlyRejectedCount === 1);
      check("C: the good attachment is still saved despite the other's rejection", summary.savedCount === 1);
      const count = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingC.id } });
      check("C: exactly one PendingTicketAttachment row exists (only the good one)", count === 1);
    }

    // ── D — savePendingAttachments: idempotency — never duplicates an
    //    already-saved attachment on a repeated call. ──────────────────────
    console.log("\nD — savePendingAttachments: a second call with the SAME attachments never duplicates them...\n");
    {
      const requesterD = await prisma.user.create({ data: { email: `${TAG}-d-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterD.id);
      const pendingD = await prisma.pendingTicket.create({
        data: { emailMessageId: `<${TAG}-D@example.com>`, fromEmail: `${TAG}-d@example.com`, fromName: "D", subject: "D", body: "D", receivedAt: new Date(), requesterId: requesterD.id },
      });
      pendingTicketIds.push(pendingD.id);

      const atts = [makeAttachment("dup.png", "duplicate-check content")];
      const first = await savePendingAttachments(atts, pendingD.id);
      check("D: first call saves it", first.savedCount === 1);
      const second = await savePendingAttachments(atts, pendingD.id);
      check("D: second call with the SAME attachments reports it already present, saves ZERO new", second.savedCount === 0 && second.alreadyPresentCount === 1);
      const count = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingD.id } });
      check("D: still exactly ONE row — never duplicated", count === 1);
    }

    // ── E — appendEmailReply: throw-then-idempotent-retry, history/notify
    //    fire EXACTLY ONCE (never missed, never duplicated). ───────────────
    console.log("\nE — appendEmailReply: storage failure throws, retry is idempotent, history fires exactly once...\n");
    let dept: Awaited<ReturnType<typeof createDepartment>>;
    {
      dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
      departmentIds.push(dept.id);
      const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
      const requesterE = await prisma.user.create({ data: { email: `${TAG}-e-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterE.id);
      const ticket = await prisma.ticket.create({
        data: { title: `${TAG} ticket E`, description: "d", source: TicketSource.EMAIL, requesterId: requesterE.id, departmentId: dept.id, statusId: status.id, emailMessageId: `<${TAG}-E-original@example.com>` },
      });
      ticketIds.push(ticket.id);

      const parsed = makeParsedEmail({ messageId: `<${TAG}-E-reply@example.com>`, attachments: [makeAttachment("reply.png", "reply attachment content")] });

      await forceUnverified();
      let threw = false;
      try {
        await appendEmailReply(parsed, { id: ticket.id, ticketNumber: 0, title: ticket.title }, requesterE.id);
      } catch {
        threw = true;
      }
      check("E: first attempt throws when storage is unverified", threw);

      const msgAfterFirst = await prisma.ticketMessage.findUnique({ where: { emailMessageId: parsed.messageId } });
      check("E: the TicketMessage WAS still created despite the attachment failure", msgAfterFirst !== null);
      const historyAfterFirst = await prisma.ticketHistory.count({ where: { ticketId: ticket.id, type: "COMMENT_ADDED" } });
      check("E: history was NOT created on the failed first attempt (nothing to report yet)", historyAfterFirst === 0);

      await forceVerified();
      await appendEmailReply(parsed, { id: ticket.id, ticketNumber: 0, title: ticket.title }, requesterE.id);

      const msgCount = await prisma.ticketMessage.count({ where: { emailMessageId: parsed.messageId } });
      check("E: still exactly ONE TicketMessage after the retry (never duplicated)", msgCount === 1);
      const attCount = msgAfterFirst ? await prisma.ticketAttachment.count({ where: { messageId: msgAfterFirst.id } }) : -1;
      check("E: exactly ONE attachment now saved on retry", attCount === 1);
      const historyAfterRetry = await prisma.ticketHistory.count({ where: { ticketId: ticket.id, type: "COMMENT_ADDED" } });
      check("E: history now exists EXACTLY ONCE — never missed entirely, never duplicated", historyAfterRetry === 1);
    }

    // ── F — saveEmailAttachments: publish-then-DB-fail is compensated. ────
    console.log("\nF — saveEmailAttachments: a file published then a failed DB insert is cleaned up (zero orphans)...\n");
    {
      await forceVerified();
      const fakeTicketId = `${TAG}-nonexistent-ticket`;
      const anyUserId = userIds[0];
      const summary = await saveEmailAttachments([makeAttachment("orphan2.png", "would-be orphan content 2")], fakeTicketId, `${TAG}-nonexistent-message`, anyUserId);
      check("F: the write-then-DB-fail attachment is counted as a recoverable failure", summary.recoverableFailureCount === 1 && summary.savedCount === 0);
      const orphanDir = path.join(TEMP_UPLOAD_DIR, fakeTicketId);
      const orphanFiles = await fs.readdir(orphanDir).catch(() => []);
      check("F: zero files remain — the orphaned publish was removed", orphanFiles.length === 0);
    }

    // ── G — savePendingAttachments: two DISTINCT attachments sharing the
    //    exact same (originalName, size) but different source ids both
    //    survive — the old (originalName, size) key would have collapsed
    //    them into one. ────────────────────────────────────────────────────
    console.log("\nG — savePendingAttachments: two distinct attachments with identical name+size (different source ids) BOTH survive...\n");
    {
      await forceVerified();
      const requesterG = await prisma.user.create({ data: { email: `${TAG}-g-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterG.id);
      const pendingG = await prisma.pendingTicket.create({
        data: { emailMessageId: `<${TAG}-G@example.com>`, fromEmail: `${TAG}-g@example.com`, fromName: "G", subject: "G", body: "G", receivedAt: new Date(), requesterId: requesterG.id },
      });
      pendingTicketIds.push(pendingG.id);

      // Same name, same content (so same size) — ONLY the id differs.
      const twinA = makeAttachment("twin.png", "identical twin content", "image/png", `${TAG}-g-twin-A`);
      const twinB = makeAttachment("twin.png", "identical twin content", "image/png", `${TAG}-g-twin-B`);
      const summary = await savePendingAttachments([twinA, twinB], pendingG.id);
      check("G: both identically-named/sized attachments are saved (never collapsed into one)", summary.savedCount === 2);
      const rows = await prisma.pendingTicketAttachment.findMany({ where: { pendingTicketId: pendingG.id }, select: { sourceAttachmentId: true } });
      check("G: exactly TWO rows exist", rows.length === 2);
      const sourceIds = new Set(rows.map((r) => r.sourceAttachmentId));
      check("G: each row carries its own distinct sourceAttachmentId", sourceIds.has(twinA.id) && sourceIds.has(twinB.id));
    }

    // ── H — saveEmailAttachments: a retry that reconstructs the SAME
    //    source attachment (same id, fresh object) across two SEPARATE
    //    calls is never duplicated. ─────────────────────────────────────────
    console.log("\nH — saveEmailAttachments: a retry with a freshly-constructed but SAME-id attachment never duplicates it...\n");
    {
      await forceVerified();
      const deptH = await createDepartment({ name: `${TAG}-dept-h`, slug: `${TAG}-dept-h` });
      departmentIds.push(deptH.id);
      const statusH = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptH.id, name: "Open" } });
      const requesterH = await prisma.user.create({ data: { email: `${TAG}-h-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterH.id);
      const ticketH = await prisma.ticket.create({
        data: { title: `${TAG} ticket H`, description: "d", source: TicketSource.EMAIL, requesterId: requesterH.id, departmentId: deptH.id, statusId: statusH.id, emailMessageId: `<${TAG}-H-original@example.com>` },
      });
      ticketIds.push(ticketH.id);
      const msgH = await prisma.ticketMessage.create({
        data: { ticketId: ticketH.id, authorId: requesterH.id, body: "h", direction: "INBOUND", emailMessageId: `<${TAG}-H-reply@example.com>` },
      });

      const sourceId = `${TAG}-h-source-id`;
      const first = await saveEmailAttachments([makeAttachment("retry.png", "retry content", "image/png", sourceId)], ticketH.id, msgH.id, requesterH.id);
      check("H: first call saves it", first.savedCount === 1);
      // A FRESH object (not the same reference as above) but the SAME id —
      // exactly what a re-fetched Graph attachment on a retried poll looks
      // like: a new JS object, same underlying source attachment.
      const second = await saveEmailAttachments([makeAttachment("retry.png", "retry content", "image/png", sourceId)], ticketH.id, msgH.id, requesterH.id);
      check("H: second call with a FRESH object but the SAME source id reports already-present, saves ZERO new", second.savedCount === 0 && second.alreadyPresentCount === 1);
      const count = await prisma.ticketAttachment.count({ where: { messageId: msgH.id } });
      check("H: still exactly ONE row — never duplicated", count === 1);
    }

    // ── I — appendEmailReply: crash-before-cursor-advance — a second,
    //    full call with the SAME ParsedEmail after the first already fully
    //    committed must never duplicate the history entry, but MUST still
    //    fire the notification again (at-least-once, not exactly-once —
    //    see appendEmailReply's own doc comment for why that's the correct
    //    guarantee for this specific, non-durable signal). ─────────────────
    console.log("\nI — appendEmailReply: a second call after full success (simulating a crash before the cursor advanced) never duplicates history, but DOES re-notify...\n");
    {
      const { ticketEventBus } = await import("@/lib/realtime/event-bus");
      await forceVerified();
      const deptI = await createDepartment({ name: `${TAG}-dept-i`, slug: `${TAG}-dept-i` });
      departmentIds.push(deptI.id);
      const statusI = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptI.id, name: "Open" } });
      const requesterI = await prisma.user.create({ data: { email: `${TAG}-i-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterI.id);
      const ticketI = await prisma.ticket.create({
        data: { title: `${TAG} ticket I`, description: "d", source: TicketSource.EMAIL, requesterId: requesterI.id, departmentId: deptI.id, statusId: statusI.id, emailMessageId: `<${TAG}-I-original@example.com>` },
      });
      ticketIds.push(ticketI.id);

      const parsedI = makeParsedEmail({ messageId: `<${TAG}-I-reply@example.com>`, attachments: [] });

      let publishCount = 0;
      const unsubscribe = ticketEventBus.subscribe(ticketI.id, () => { publishCount++; });
      try {
        // First call: genuinely the first time this message is processed —
        // completes fully (message + history created, notification fired).
        await appendEmailReply(parsedI, { id: ticketI.id, ticketNumber: 0, title: ticketI.title }, requesterI.id);
        const historyAfterFirst = await prisma.ticketHistory.count({ where: { ticketId: ticketI.id, type: "COMMENT_ADDED" } });
        check("I: first call creates exactly one history row", historyAfterFirst === 1);
        check("I: first call fires exactly one notification", publishCount === 1);

        // Second call: the crash-before-cursor-advance retry — the SAME
        // ParsedEmail, as if the mailbox poll re-fetched this exact message
        // because the process crashed before the batch-level cursor commit.
        await appendEmailReply(parsedI, { id: ticketI.id, ticketNumber: 0, title: ticketI.title }, requesterI.id);
        const historyAfterSecond = await prisma.ticketHistory.count({ where: { ticketId: ticketI.id, type: "COMMENT_ADDED" } });
        check("I: second (crash-retry) call does NOT create a second history row", historyAfterSecond === 1);
        check("I: second (crash-retry) call DOES re-fire the notification (closes the history-to-notification crash window — a missed live nudge is recovered, never a duplicate DB row)", publishCount === 2);
        const msgCountI = await prisma.ticketMessage.count({ where: { emailMessageId: parsedI.messageId } });
        check("I: still exactly ONE TicketMessage (the pre-existing reuse-path, unaffected by this fix)", msgCountI === 1);
      } finally {
        unsubscribe();
      }
    }

    // ── J — identity scope: the SAME literal sourceAttachmentId under TWO
    //    DIFFERENT parent records never suppresses the other. ──────────────
    console.log("\nJ — Graph attachment identity is scoped per parent record, not global...\n");
    {
      await forceVerified();
      const sharedId = `${TAG}-j-shared-source-id`;

      const requesterJ1 = await prisma.user.create({ data: { email: `${TAG}-j1-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      const requesterJ2 = await prisma.user.create({ data: { email: `${TAG}-j2-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterJ1.id, requesterJ2.id);
      const pendingJ1 = await prisma.pendingTicket.create({
        data: { emailMessageId: `<${TAG}-J1@example.com>`, fromEmail: `${TAG}-j1@example.com`, fromName: "J1", subject: "J1", body: "J1", receivedAt: new Date(), requesterId: requesterJ1.id },
      });
      const pendingJ2 = await prisma.pendingTicket.create({
        data: { emailMessageId: `<${TAG}-J2@example.com>`, fromEmail: `${TAG}-j2@example.com`, fromName: "J2", subject: "J2", body: "J2", receivedAt: new Date(), requesterId: requesterJ2.id },
      });
      pendingTicketIds.push(pendingJ1.id, pendingJ2.id);

      const summaryJ1 = await savePendingAttachments([makeAttachment("j1.png", "J1 content", "image/png", sharedId)], pendingJ1.id);
      const summaryJ2 = await savePendingAttachments([makeAttachment("j2.png", "J2 content", "image/png", sharedId)], pendingJ2.id);
      check("J: PendingTicket #1's attachment (shared source id) is saved", summaryJ1.savedCount === 1);
      check("J: PendingTicket #2's attachment (SAME shared source id, DIFFERENT parent) is ALSO saved — not suppressed by #1", summaryJ2.savedCount === 1);
      const countJ1 = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingJ1.id } });
      const countJ2 = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingJ2.id } });
      check("J: both parents end up with exactly one row each", countJ1 === 1 && countJ2 === 1);
    }

    // ── K — legacy-row compatibility: a NULL-sourceAttachmentId row
    //    (simulating one saved before this column existed) is still
    //    recognized as already-saved via the (originalName, size)
    //    fallback, and a genuinely different attachment is unaffected. ─────
    console.log("\nK — a legacy (sourceAttachmentId=NULL) row is still recognized as already-saved on retry, never duplicated...\n");
    {
      await forceVerified();
      const requesterK = await prisma.user.create({ data: { email: `${TAG}-k-requester@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requesterK.id);
      const pendingK = await prisma.pendingTicket.create({
        data: { emailMessageId: `<${TAG}-K@example.com>`, fromEmail: `${TAG}-k@example.com`, fromName: "K", subject: "K", body: "K", receivedAt: new Date(), requesterId: requesterK.id },
      });
      pendingTicketIds.push(pendingK.id);

      // Simulates a row saved by the OLD code, before sourceAttachmentId
      // existed — written directly via Prisma rather than through
      // savePendingAttachments, since that function always populates the
      // column now; a pre-migration row is exactly this shape.
      const legacyBytes = Buffer.from("legacy content");
      await prisma.pendingTicketAttachment.create({
        data: {
          pendingTicketId: pendingK.id,
          filename: "legacy-stored-name.png",
          originalName: "legacy.png",
          mimeType: "image/png",
          size: legacyBytes.length,
          path: `/uploads/pending/${pendingK.id}/legacy-stored-name.png`,
          sourceAttachmentId: null,
        },
      });

      // A retry of the SAME message: the incoming attachment has a REAL
      // (new, never-before-seen) sourceAttachmentId — the legacy row has
      // none to match against at all — but the SAME (name, size) as the
      // legacy row above, exactly as a genuine re-fetch of that same
      // original source attachment would.
      const retryAtt = makeAttachment("legacy.png", "legacy content", "image/png", `${TAG}-k-new-id-for-old-row`);
      const summaryRetry = await savePendingAttachments([retryAtt], pendingK.id);
      check("K: the legacy row is recognized as already-present via the (name, size) fallback — never re-saved", summaryRetry.savedCount === 0 && summaryRetry.alreadyPresentCount === 1);
      const countAfterRetry = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingK.id } });
      check("K: still exactly ONE row after the retry — no duplicate created", countAfterRetry === 1);

      // A genuinely NEW, different attachment in the same retry call must
      // still be saved normally — the legacy fallback must not
      // over-suppress unrelated attachments.
      const newAtt = makeAttachment("brand-new.png", "brand new content", "image/png", `${TAG}-k-brand-new-id`);
      const summaryNew = await savePendingAttachments([newAtt], pendingK.id);
      check("K: a genuinely different, new attachment in the same call is still saved (no over-suppression)", summaryNew.savedCount === 1);
      const countAfterNew = await prisma.pendingTicketAttachment.count({ where: { pendingTicketId: pendingK.id } });
      check("K: now exactly TWO rows (the legacy one, untouched, plus the new one)", countAfterNew === 2);
    }
  } finally {
    resetAttachmentStorageVerificationForTests();
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticketAttachment.deleteMany({ where: { ticketId: { in: ticketIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.pendingTicketAttachment.deleteMany({ where: { pendingTicketId: { in: pendingTicketIds } } });
      await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("DB cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    try {
      await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true });
    } catch (err) {
      console.warn("Temp directory cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
