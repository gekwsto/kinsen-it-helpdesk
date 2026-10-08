/**
 * MailboxPollCursor — the replacement for Outlook's isRead flag as
 * processInboundEmails' (lib/ticket-email-service.ts) "what's already been
 * looked at" signal. Built so shared mailboxes are never touched by this
 * app (no markAsRead, no moveMessage to a "Processed" folder) — some users
 * only have Outlook access to them and must see a normal, untouched Inbox.
 *
 * Covers what scripts/test-multi-mailbox-inbound-email.ts's broader
 * end-to-end run doesn't specifically isolate:
 *  1. A never-before-polled mailbox is bounded to
 *     `now - INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS` (default 72h) — NEVER
 *     the Unix epoch, which used to let the first poll crawl a mailbox's
 *     entire historical Inbox (the real incident this fix addresses; see
 *     lib/services/inbound-mailbox-service.ts's getMailboxPollCursor).
 *     An existing cursor is completely unaffected by this bound.
 *  2. The cursor advances past a successfully-handled message.
 *  3. A per-message FAILURE freezes the cursor at that message — it (and
 *     everything chronologically after it in the same batch) is retried
 *     on the very next poll.
 *  4. The retried, already-successful LATER messages from that batch are
 *     safely no-ops the second time (existing messageId dedup), never
 *     creating a duplicate PendingTicket/Ticket.
 *  5. advanceMailboxPollCursor never moves the cursor backward (GREATEST
 *     semantics), including under two "concurrent" advances.
 *  6. markAsRead/moveMessage are never called even on the retry pass.
 *
 * Usage: npx tsx scripts/test-mailbox-poll-cursor.ts
 * Requires a reachable DATABASE_URL — skips (not fails) if unreachable.
 */
process.env.GRAPH_TENANT_ID = "aaaaaaaa-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_ID = "bbbbbbbb-1111-2222-3333-444444444444";
process.env.GRAPH_CLIENT_SECRET = "mock-graph-client-secret-1234567890";
process.env.GRAPH_USER_EMAIL = "central-support-cursor@kinsen.gr";

import { prisma } from "@/lib/prisma";
import { getMailboxPollCursor, advanceMailboxPollCursor } from "@/lib/services/inbound-mailbox-service";
import { processInboundEmails } from "@/lib/ticket-email-service";
import { createDepartment, setDepartmentInboundEmail } from "@/lib/services/department-service";
import type { GraphMailMessage } from "@/lib/microsoft-graph";

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

const RUN_ID = Date.now();
const CENTRAL = "central-support-cursor@kinsen.gr";
const originalFetch = global.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mailboxFromUrl(url: string): string | null {
  const match = url.match(/\/users\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}

function makeMessage(overrides: Partial<GraphMailMessage> & { id: string; receivedDateTime: string }): GraphMailMessage {
  return {
    subject: "Test Subject",
    bodyPreview: "preview",
    body: { contentType: "text", content: "Test body" },
    from: { emailAddress: { name: "Sender", address: `sender-${overrides.id}@example.com` } },
    toRecipients: [],
    internetMessageId: `<${overrides.id}@test.local>`,
    conversationId: `conv-${overrides.id}`,
    hasAttachments: false,
    isRead: false,
    internetMessageHeaders: [],
    ...overrides,
  };
}

/**
 * Installs a fetch mock serving a FIXED batch of messages for `mailbox`
 * regardless of the `$filter` cursor value sent (this test controls what
 * "since the cursor" should return by only putting messages with the right
 * receivedDateTime in the fixture — same approach
 * test-multi-mailbox-inbound-email.ts already uses). A message whose
 * `internetMessageId` is in `failFor` makes the REST OF THE RESPONSE BODY
 * fine, but parsing/processing that one specific message throw — simulated
 * via a deliberately malformed `from` address the real parseIncomingEmail
 * rejects, proving the cursor-freeze behavior without needing to reach
 * into private pipeline internals.
 */
function installFixedBatchMock(
  messagesByMailbox: Record<string, GraphMailMessage[]>
): { markAsReadCalls: string[]; moveCalls: string[] } {
  const markAsReadCalls: string[] = [];
  const moveCalls: string[] = [];

  global.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("login.microsoftonline.com")) {
      return jsonResponse(200, { access_token: "mock-app-token" });
    }

    const mailbox = mailboxFromUrl(url);
    if (!mailbox) return jsonResponse(404, { error: { message: "unexpected URL in test mock", url } });

    if (url.includes("/mailFolders/Inbox/messages") && method === "GET") {
      return jsonResponse(200, { value: messagesByMailbox[mailbox] ?? [] });
    }
    if (url.includes("/messages/") && method === "PATCH") {
      markAsReadCalls.push(mailbox);
      return jsonResponse(200, {});
    }
    if (url.includes("/messages/") && url.includes("/move") && method === "POST") {
      moveCalls.push(mailbox);
      return jsonResponse(200, {});
    }

    return jsonResponse(404, { error: { message: "unhandled mock URL", url, method } });
  }) as typeof fetch;

  return { markAsReadCalls, moveCalls };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await dbReachable())) {
    console.log("DATABASE_URL unreachable — skipping (this is a skip, not a failure).");
    return;
  }

  const deptIds: string[] = [];
  const pendingTicketIds: string[] = [];
  const userEmails: string[] = [];
  const mailboxesToCleanup = [CENTRAL];

  try {
    console.log("\n=== 1. A never-before-polled mailbox is bounded to now - lookback, never the Unix epoch ===\n");
    const freshMailbox = `fresh-${RUN_ID}@kinsen.gr`;
    mailboxesToCleanup.push(freshMailbox);
    const beforeFreshCall = Date.now();
    const freshCursor = await getMailboxPollCursor(freshMailbox);
    const afterFreshCall = Date.now();
    check("Cursor for a mailbox with no row yet is NEVER the Unix epoch", freshCursor.getTime() !== 0);
    const defaultLookbackMs = 72 * 60 * 60 * 1000;
    check(
      "...and is approximately now - 72h (the default INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS, unset in this test's env)",
      freshCursor.getTime() >= beforeFreshCall - defaultLookbackMs - 5000 && freshCursor.getTime() <= afterFreshCall - defaultLookbackMs + 5000
    );

    console.log("\n=== 1b. A CUSTOM lookback is honored ===\n");
    const customLookbackMailbox = `fresh-custom-${RUN_ID}@kinsen.gr`;
    mailboxesToCleanup.push(customLookbackMailbox);
    process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS = "6";
    const beforeCustomCall = Date.now();
    const customCursor = await getMailboxPollCursor(customLookbackMailbox);
    const afterCustomCall = Date.now();
    const customLookbackMs = 6 * 60 * 60 * 1000;
    check(
      "A custom INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS=6 is honored for a fresh mailbox",
      customCursor.getTime() >= beforeCustomCall - customLookbackMs - 5000 && customCursor.getTime() <= afterCustomCall - customLookbackMs + 5000
    );
    delete process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS;

    console.log("\n=== 1c. An invalid lookback (zero/negative/non-numeric) falls back to the safe default, never an unbounded poll ===\n");
    for (const invalid of ["0", "-5", "not-a-number", ""]) {
      const invalidMailbox = `fresh-invalid-${invalid.replace(/[^a-z0-9]/gi, "x") || "empty"}-${RUN_ID}@kinsen.gr`;
      mailboxesToCleanup.push(invalidMailbox);
      if (invalid === "") delete process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS;
      else process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS = invalid;
      const beforeInvalidCall = Date.now();
      const invalidCursor = await getMailboxPollCursor(invalidMailbox);
      const afterInvalidCall = Date.now();
      check(
        `INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS="${invalid}" falls back to the default 72h bound, never epoch/unbounded`,
        invalidCursor.getTime() !== 0 &&
          invalidCursor.getTime() >= beforeInvalidCall - defaultLookbackMs - 5000 &&
          invalidCursor.getTime() <= afterInvalidCall - defaultLookbackMs + 5000
      );
    }
    delete process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS;

    console.log("\n=== 1d. A mailbox WITH an existing cursor ignores the lookback entirely ===\n");
    const existingCursorMailbox = `fresh-existing-${RUN_ID}@kinsen.gr`;
    mailboxesToCleanup.push(existingCursorMailbox);
    const persistedCursorValue = new Date("2020-05-01T00:00:00.000Z"); // deliberately older than any lookback window — proves the stored value, not the bound, wins
    await advanceMailboxPollCursor(existingCursorMailbox, persistedCursorValue);
    process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS = "1"; // a tiny window that would clearly NOT reach 2020 if it were (wrongly) applied
    const existingCursorResult = await getMailboxPollCursor(existingCursorMailbox);
    check("An EXISTING cursor's exact persisted value wins regardless of the lookback config", existingCursorResult.getTime() === persistedCursorValue.getTime());
    delete process.env.INBOUND_EMAIL_INITIAL_LOOKBACK_HOURS;

    console.log("\n=== 5. advanceMailboxPollCursor never moves the cursor backward ===\n");
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-06-01T00:00:00.000Z");
    const tEarlier = new Date("2026-03-01T00:00:00.000Z");
    await advanceMailboxPollCursor(freshMailbox, t1);
    check("First advance sets the cursor", (await getMailboxPollCursor(freshMailbox)).getTime() === t1.getTime());
    await advanceMailboxPollCursor(freshMailbox, t2);
    check("A later advance moves it forward", (await getMailboxPollCursor(freshMailbox)).getTime() === t2.getTime());
    await advanceMailboxPollCursor(freshMailbox, tEarlier);
    check("An EARLIER 'advance' (e.g. two overlapping poll runs racing) never moves it backward — stays at t2", (await getMailboxPollCursor(freshMailbox)).getTime() === t2.getTime());

    console.log("\n=== 2, 3, 4, 6. Real end-to-end poll: success advances, failure freezes, retry is a safe no-op, never marks read/moves ===\n");
    const dept = await createDepartment({ name: `CursorFreeze Dept ${RUN_ID}`, slug: `cursorfreeze-dept-${RUN_ID}` });
    deptIds.push(dept.id);
    const deptEmail = `cursorfreeze-${RUN_ID}@kinsen.gr`;
    await setDepartmentInboundEmail(dept.id, deptEmail);
    mailboxesToCleanup.push(deptEmail);

    const baseTime = new Date("2026-01-01T00:00:00.000Z").getTime();
    const okMsgId = `cursor-ok-${RUN_ID}`;
    const failMsgId = `cursor-fail-${RUN_ID}`;
    const afterFailMsgId = `cursor-after-fail-${RUN_ID}`;

    // Three messages, strictly increasing receivedDateTime: one that
    // processes fine, then one engineered to make parseIncomingEmail
    // itself throw (a missing `body` — the parser unconditionally reads
    // `message.body.contentType`), then one more that WOULD process fine
    // on its own.
    const okMessage = makeMessage({ id: okMsgId, subject: `Cursor OK ${RUN_ID}`, receivedDateTime: new Date(baseTime).toISOString() });
    const failMessage = {
      ...makeMessage({ id: failMsgId, subject: `Cursor Fail ${RUN_ID}`, receivedDateTime: new Date(baseTime + 1000).toISOString() }),
      body: undefined as unknown as GraphMailMessage["body"],
    };
    const afterFailMessage = makeMessage({ id: afterFailMsgId, subject: `Cursor After Fail ${RUN_ID}`, receivedDateTime: new Date(baseTime + 2000).toISOString() });
    userEmails.push(`sender-${okMsgId}@example.com`, `sender-${afterFailMsgId}@example.com`);

    const mock1 = installFixedBatchMock({ [deptEmail]: [okMessage, failMessage, afterFailMessage] });
    const result1 = await processInboundEmails();
    restoreFetch();

    check("2. The OK message created a pending ticket", result1.created >= 1);
    check("3. The run recorded at least one error (the deliberately-broken message)", result1.errors >= 1);
    check("6. markAsRead was NEVER called, even for the successfully-processed message", mock1.markAsReadCalls.length === 0);
    check("6. moveMessage was NEVER called", mock1.moveCalls.length === 0);

    const ptOk = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${okMsgId}@test.local>` } });
    if (ptOk) pendingTicketIds.push(ptOk.id);
    check("...the OK message's PendingTicket genuinely exists", ptOk !== null);

    // The message chronologically AFTER the failure is STILL processed in
    // this same run — a per-message failure never aborts the rest of the
    // already-fetched batch (pre-existing behavior, unchanged by this
    // task). What actually freezes is the PERSISTED cursor, below — the
    // real invariant this task adds.
    const ptAfterFail = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${afterFailMsgId}@test.local>` } });
    if (ptAfterFail) pendingTicketIds.push(ptAfterFail.id);
    check("...the message AFTER the failure is still processed within the SAME run (one failure doesn't abort the rest of the batch)", ptAfterFail !== null);

    const cursorAfterRun1 = await getMailboxPollCursor(deptEmail);
    check("3. But the mailbox's PERSISTED cursor only advanced up to the OK message, not past the failed one — even though a later message in the batch did succeed", cursorAfterRun1.getTime() === baseTime);

    console.log("\n=== 3, 4. Next poll: the failed message is retried, the OK one is safely skipped as a duplicate ===\n");
    // Fix the broken message for the retry (same id/receivedDateTime — a
    // real retry would get the SAME Graph message back, now fetchable
    // again since the cursor never advanced past it).
    const fixedFailMessage = makeMessage({ id: failMsgId, subject: `Cursor Fail ${RUN_ID}`, receivedDateTime: new Date(baseTime + 1000).toISOString() });
    userEmails.push(`sender-${failMsgId}@example.com`);
    const mock2 = installFixedBatchMock({ [deptEmail]: [okMessage, fixedFailMessage, afterFailMessage] });
    const result2 = await processInboundEmails();
    restoreFetch();

    // On retry, the WHOLE batch (ok, now-fixed fail, afterFail) is fetched
    // again — ok and afterFail were already fully processed in run 1 (they
    // just never got to update the PERSISTED cursor, since the failure
    // between them froze it) and are correctly re-recognized as duplicates
    // via messageId; only the now-fixed message is genuinely new work.
    check("4. Both the OK and after-failure messages are skipped as duplicates on retry, not reprocessed/re-created", result2.skipped >= 2);
    check("3. The previously-failing message now succeeds", result2.created >= 1 || result2.appended >= 1);
    const ptFail = await prisma.pendingTicket.findUnique({ where: { emailMessageId: `<${failMsgId}@test.local>` } });
    if (ptFail) pendingTicketIds.push(ptFail.id);
    check("...and its PendingTicket now genuinely exists", ptFail !== null);

    const dupOkCount = await prisma.pendingTicket.count({ where: { emailMessageId: `<${okMsgId}@test.local>` } });
    check("4. Still exactly ONE PendingTicket for the OK message — no duplicate created across the two polls", dupOkCount === 1);
    const dupAfterFailCount = await prisma.pendingTicket.count({ where: { emailMessageId: `<${afterFailMsgId}@test.local>` } });
    check("4. Still exactly ONE PendingTicket for the after-failure message too", dupAfterFailCount === 1);

    check("6. markAsRead was NEVER called on the retry pass either", mock2.markAsReadCalls.length === 0);
    check("6. moveMessage was NEVER called on the retry pass either", mock2.moveCalls.length === 0);

    const cursorAfterRun2 = await getMailboxPollCursor(deptEmail);
    check("The cursor finally advanced past all three messages", cursorAfterRun2.getTime() === baseTime + 2000);
  } finally {
    restoreFetch();
    try {
      if (pendingTicketIds.length > 0) await prisma.pendingTicketAttachment.deleteMany({ where: { pendingTicketId: { in: pendingTicketIds } } });
      if (pendingTicketIds.length > 0) await prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } });
      await prisma.emailProcessingLog.deleteMany({ where: { mailbox: { contains: `${RUN_ID}` } } });
      await prisma.mailboxPollCursor.deleteMany({ where: { mailbox: { in: mailboxesToCleanup } } });
      if (userEmails.length > 0) await prisma.user.deleteMany({ where: { email: { in: userEmails } } });
      if (deptIds.length > 0) {
        await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } });
        await prisma.department.deleteMany({ where: { id: { in: deptIds } } });
      }
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
