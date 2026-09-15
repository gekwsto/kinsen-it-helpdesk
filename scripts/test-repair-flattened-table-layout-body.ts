/**
 * Regression coverage for scripts/repair-flattened-table-layout-body.ts —
 * the narrowly-scoped, dry-run-by-default KIN-595 historical recovery tool
 * (see that file's own doc comment). Every Graph call is mocked
 * (mock.module on "@/lib/microsoft-graph") so this never touches a real
 * mailbox or production data — all fixtures are synthetic, created and torn
 * down against the local test database like every other script in this
 * suite.
 *
 * Proves (closure-pass requirements):
 *   A. Dry-run performs zero writes.
 *   B. Apply updates exactly the intended related rows (Ticket.description +
 *      the matching initial TicketMessage.body + the originating
 *      PendingTicket.body), in one transaction.
 *   C. A LATER reply TicketMessage on the same ticket is left byte-for-byte
 *      unchanged.
 *   D. Wrong/ambiguous Graph message results abort with zero writes — both
 *      an ambiguous-mailbox case and a mismatched-internetMessageId case.
 *   E. A non-email Ticket (source: WEB) is rejected outright.
 *   F. A second apply with identical (already-recovered) content is a
 *      no-op/idempotent — reports nothing written.
 *
 * Also covers the --pending=<id> path's own identity verification, and a
 * missing-EmailProcessingLog abort case.
 *
 * Must run with --experimental-test-module-mocks (mocks @/lib/microsoft-graph).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-repair-flattened-table-layout-body.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { mock } from "node:test";

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
const MAILBOX = `dept-mailbox-${RUN_ID}@kinsen.gr`;
const OTHER_MAILBOX = `other-mailbox-${RUN_ID}@kinsen.gr`;

/** A compact table-laid-out Outlook-style header — enough to prove recovery restores real row structure, not a full replica of the KIN-595 fixture used elsewhere. */
function originalHtml(runId: number, tag: string): string {
  return `<div class="WordSection1">
<p class="MsoNormal">Please see below.</p>
<table border="0" cellspacing="0" cellpadding="0" style="width:100%;">
<tr><td><b>From:</b></td><td><span>Original Sender ${tag} &lt;sender-${runId}@example.com&gt;</span></td></tr>
<tr><td><b>Sent:</b></td><td><span>Monday, January 5, 2026 9:14 AM</span></td></tr>
<tr><td><b>Subject:</b></td><td><span>Recovery test ${tag}</span></td></tr>
</table>
<p class="MsoNormal">Thanks,<br>Original Sender</p>
</div>`;
}

/** What the OLD, pre-fix converter would have produced for the HTML above — all rows flattened onto one line, exactly the KIN-595 symptom. Used as the "already flattened historical data" fixture the repair script must recover. */
function flattenedLegacyBody(runId: number, tag: string): string {
  return `Please see below.\n\nFrom: Original Sender ${tag} <sender-${runId}@example.com> Sent: Monday, January 5, 2026 9:14 AM Subject: Recovery test ${tag}\n\nThanks,\nOriginal Sender`;
}

function makeGraphMessage(runId: number, tag: string, internetMessageId: string) {
  return {
    id: `graph-id-${runId}-${tag}`,
    subject: `Recovery test ${tag}`,
    bodyPreview: "preview",
    body: { contentType: "html" as const, content: originalHtml(runId, tag) },
    from: { emailAddress: { name: "Original Sender", address: `sender-${runId}@example.com` } },
    toRecipients: [],
    internetMessageId,
    conversationId: `conv-${runId}-${tag}`,
    receivedDateTime: new Date().toISOString(),
    hasAttachments: false,
    isRead: false,
    internetMessageHeaders: [],
  };
}

async function main() {
  // ── Mock the ENTIRE @/lib/microsoft-graph module before anything imports
  // it — a map of internetMessageId -> mock message (or a special marker
  // for "return a mismatched message"), keyed so different sub-tests below
  // can each control exactly what Graph "returns" without interfering with
  // each other. ─────────────────────────────────────────────────────────
  const mockedMessages = new Map<string, ReturnType<typeof makeGraphMessage> | "MISMATCH" | null>();
  const graphCalls: Array<{ mailbox: string; internetMessageId: string }> = [];

  mock.module("@/lib/microsoft-graph", {
    namedExports: {
      getAppOnlyGraphAccessToken: async () => "mock-token",
      getCentralMailbox: () => "central@kinsen.gr",
      GraphConfigurationError: class GraphConfigurationError extends Error {},
      microsoftGraph: {
        async getMessageByInternetMessageId(mailbox: string, internetMessageId: string) {
          graphCalls.push({ mailbox, internetMessageId });
          const entry = mockedMessages.get(internetMessageId);
          if (entry === undefined || entry === null) return null;
          if (entry === "MISMATCH") return makeGraphMessage(RUN_ID, "mismatched", `<totally-different-${RUN_ID}@test.local>`);
          return entry;
        },
        // Never called by the repair script — present only so a stray call
        // fails loudly (wrong message) instead of silently no-op-ing.
        async markAsRead() {
          throw new Error("markAsRead must never be called by the repair script");
        },
        async moveMessage() {
          throw new Error("moveMessage must never be called by the repair script");
        },
      },
    },
  });

  const { prisma } = await import("@/lib/prisma");
  const { Role, AuthProvider, DepartmentRole } = await import("@prisma/client");
  const { grantManualMembership } = await import("@/lib/services/department-membership-service");
  const { ensureStatusForDepartment, ensurePriorityForDepartment, STARTER_STATUSES, STARTER_PRIORITIES } = await import("@/lib/services/config-starter-data");
  const { repairTicket, repairPending } = await import("@/scripts/repair-flattened-table-layout-body");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let dept: { id: string } | undefined;
  let acceptingUser: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];
  const pendingTicketIds: string[] = [];
  const userIds: string[] = [];
  const logIds: string[] = [];

  /** Builds one fully-accepted "legacy flattened" ticket: PendingTicket (ACCEPTED) -> Ticket + initial TicketMessage, both bodies = the pre-fix flattened text, plus one EmailProcessingLog row recording the mailbox. Simulates data written before this fix existed. */
  async function buildLegacyAcceptedTicket(tag: string) {
    const emailMessageId = `<legacy-${RUN_ID}-${tag}@test.local>`;
    const flattened = flattenedLegacyBody(RUN_ID, tag);

    const log = await prisma.emailProcessingLog.create({
      data: { runId: `run-${RUN_ID}-${tag}`, mailbox: MAILBOX, messageId: emailMessageId, fromEmail: `sender-${RUN_ID}@example.com`, subject: `Recovery test ${tag}`, action: "CREATED_TICKET" },
    });
    logIds.push(log.id);

    const requester = await prisma.user.create({
      data: { email: `req-${RUN_ID}-${tag}@example.com`, name: "Original Sender", role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
    });
    userIds.push(requester.id);

    const pending = await prisma.pendingTicket.create({
      data: {
        emailMessageId,
        fromEmail: `sender-${RUN_ID}@example.com`,
        fromName: "Original Sender",
        subject: `Recovery test ${tag}`,
        body: flattened,
        receivedAt: new Date(),
        departmentId: dept!.id,
        requesterId: requester.id,
      },
    });
    pendingTicketIds.push(pending.id);

    const ticket = await prisma.ticket.create({
      data: {
        title: `Recovery test ${tag}`,
        description: flattened,
        source: "EMAIL",
        requesterId: requester.id,
        departmentId: dept!.id,
        statusId: (await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept!.id } })).id,
        emailMessageId,
      },
    });
    ticketIds.push(ticket.id);

    const initialMessage = await prisma.ticketMessage.create({
      data: { ticketId: ticket.id, authorId: requester.id, body: flattened, direction: "INBOUND", emailMessageId, fromEmail: `sender-${RUN_ID}@example.com`, fromName: "Original Sender" },
    });

    await prisma.pendingTicket.update({ where: { id: pending.id }, data: { status: "ACCEPTED", acceptedTicketId: ticket.id, acceptedAt: new Date() } });

    mockedMessages.set(emailMessageId, makeGraphMessage(RUN_ID, tag, emailMessageId));

    return { emailMessageId, flattened, ticket, pending, initialMessage, requester };
  }

  try {
    console.log("\nSetting up an isolated department + accepting user...\n");
    dept = await prisma.department.create({ data: { name: `Repair Dept ${RUN_ID}`, slug: `repair-dept-${RUN_ID}` }, select: { id: true } });
    await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);
    await ensurePriorityForDepartment(prisma, dept.id, STARTER_PRIORITIES[0]);
    acceptingUser = await prisma.user.create({ data: { email: `repair-accepting-${RUN_ID}@kinsen.gr`, role: Role.IT_AGENT, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(acceptingUser.id);
    await grantManualMembership(acceptingUser.id, dept.id, { role: DepartmentRole.AGENT_ASSIGNEE }, prisma);

    // ── A + B + C — dry-run zero writes, then apply updates exactly the
    // intended rows, leaving a later reply untouched ──────────────────────
    console.log("\nA/B/C — dry-run performs zero writes; apply updates Ticket.description + initial TicketMessage.body + originating PendingTicket.body in one transaction; a later reply is untouched...\n");
    {
      const { emailMessageId, flattened, ticket, pending, initialMessage, requester } = await buildLegacyAcceptedTicket("abc");

      // A later reply on the SAME ticket — must never be touched.
      const laterReplyBody = "This is a completely unrelated later reply, must never change.";
      const laterReply = await prisma.ticketMessage.create({
        data: { ticketId: ticket.id, authorId: requester.id, body: laterReplyBody, direction: "INBOUND", emailMessageId: `<later-reply-${RUN_ID}@test.local>`, fromEmail: requester.email, fromName: "Original Sender" },
      });

      // A. Dry run.
      const dryRunResult = await repairTicket(ticket.ticketNumber, false);
      check("A: dry-run result is ok", dryRunResult.ok === true);
      if (dryRunResult.ok) {
        check("A: dry-run correctly resolves the mailbox", dryRunResult.mailbox === MAILBOX);
        check("A: dry-run reports 3 changed fields (description, initial message, originating pending)", dryRunResult.changes.length === 3 && dryRunResult.changes.every((c) => c.changed));
        check("A: dry-run did not write anything (wrote === false)", dryRunResult.wrote === false);
      }
      const afterDryRunTicket = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { description: true } });
      const afterDryRunMessage = await prisma.ticketMessage.findUnique({ where: { id: initialMessage.id }, select: { body: true } });
      const afterDryRunPending = await prisma.pendingTicket.findUnique({ where: { id: pending.id }, select: { body: true } });
      check("A: Ticket.description is byte-for-byte unchanged after dry-run", afterDryRunTicket?.description === flattened);
      check("A: initial TicketMessage.body is byte-for-byte unchanged after dry-run", afterDryRunMessage?.body === flattened);
      check("A: PendingTicket.body is byte-for-byte unchanged after dry-run", afterDryRunPending?.body === flattened);

      // B. Apply.
      const applyResult = await repairTicket(ticket.ticketNumber, true);
      check("B: apply result is ok", applyResult.ok === true);
      if (applyResult.ok) check("B: apply reports it wrote (wrote === true)", applyResult.wrote === true);

      const recoveredExpected = await originalHtmlToExpectedText(RUN_ID, "abc");
      const afterApplyTicket = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { description: true } });
      const afterApplyMessage = await prisma.ticketMessage.findUnique({ where: { id: initialMessage.id }, select: { body: true } });
      const afterApplyPending = await prisma.pendingTicket.findUnique({ where: { id: pending.id }, select: { body: true } });
      check("B: Ticket.description now holds readable, row-separated recovered text", (afterApplyTicket?.description ?? "").includes(`From: Original Sender abc <sender-${RUN_ID}@example.com>`));
      check("B: Ticket.description no longer contains the flattened single-line join", !(afterApplyTicket?.description ?? "").includes("Sent: Monday, January 5, 2026 9:14 AM Subject:"));
      check("B: initial TicketMessage.body matches Ticket.description exactly (same recovered text)", afterApplyMessage?.body === afterApplyTicket?.description);
      check("B: originating PendingTicket.body matches too", afterApplyPending?.body === afterApplyTicket?.description);
      check("B: recovered text matches exactly what parseIncomingEmail itself would produce for the original HTML", afterApplyTicket?.description === recoveredExpected);

      // C. The later reply is byte-for-byte unchanged.
      const laterReplyAfter = await prisma.ticketMessage.findUnique({ where: { id: laterReply.id }, select: { body: true } });
      check("C: the later, unrelated reply TicketMessage is byte-for-byte unchanged", laterReplyAfter?.body === laterReplyBody);

      // F. A second apply with identical (already-recovered) content is a no-op.
      const secondApply = await repairTicket(ticket.ticketNumber, true);
      check("F: second apply result is ok", secondApply.ok === true);
      if (secondApply.ok) {
        check("F: second apply reports zero changed fields (fully idempotent)", secondApply.changes.every((c) => !c.changed));
        check("F: second apply did not write anything (wrote === false)", secondApply.wrote === false);
      }
    }

    // ── D1 — ambiguous mailbox aborts with zero writes ────────────────────
    console.log("\nD1 — two different mailboxes recorded for the same message aborts with zero writes...\n");
    {
      const { flattened, ticket } = await buildLegacyAcceptedTicket("ambiguous");
      // A second EmailProcessingLog row for the SAME messageId but a DIFFERENT mailbox.
      const secondLog = await prisma.emailProcessingLog.create({
        data: { runId: `run-${RUN_ID}-ambiguous-2`, mailbox: OTHER_MAILBOX, messageId: `<legacy-${RUN_ID}-ambiguous@test.local>`, fromEmail: `sender-${RUN_ID}@example.com`, subject: "Recovery test ambiguous", action: "CREATED_TICKET" },
      });
      logIds.push(secondLog.id);

      const result = await repairTicket(ticket.ticketNumber, true);
      check("D1: ambiguous-mailbox result is NOT ok", result.ok === false);
      if (!result.ok) check("D1: reason mentions ambiguity", /ambiguous/i.test(result.reason));
      const after = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { description: true } });
      check("D1: Ticket.description unchanged after the aborted apply attempt", after?.description === flattened);
    }

    // ── D2 — mismatched Graph message identity aborts with zero writes ────
    console.log("\nD2 — Graph returning a message with a different internetMessageId aborts with zero writes...\n");
    {
      const { emailMessageId, flattened, ticket } = await buildLegacyAcceptedTicket("mismatch");
      mockedMessages.set(emailMessageId, "MISMATCH");

      const result = await repairTicket(ticket.ticketNumber, true);
      check("D2: mismatched-identity result is NOT ok", result.ok === false);
      if (!result.ok) check("D2: reason mentions the mismatch", /different internetMessageId|mismatched/i.test(result.reason));
      const after = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { description: true } });
      check("D2: Ticket.description unchanged after the aborted apply attempt", after?.description === flattened);
    }

    // ── D3 — no EmailProcessingLog row at all aborts with zero writes ─────
    console.log("\nD3 — no EmailProcessingLog row recording the source mailbox aborts with zero writes...\n");
    {
      const emailMessageId = `<legacy-${RUN_ID}-nolog@test.local>`;
      const flattened = flattenedLegacyBody(RUN_ID, "nolog");
      const requester = await prisma.user.create({ data: { email: `req-${RUN_ID}-nolog@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requester.id);
      const ticket = await prisma.ticket.create({
        data: {
          title: "Recovery test nolog",
          description: flattened,
          source: "EMAIL",
          requesterId: requester.id,
          departmentId: dept.id,
          statusId: (await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id } })).id,
          emailMessageId,
        },
      });
      ticketIds.push(ticket.id);

      const result = await repairTicket(ticket.ticketNumber, true);
      check("D3: missing-mailbox-log result is NOT ok", result.ok === false);
      if (!result.ok) check("D3: reason mentions no EmailProcessingLog row", /No EmailProcessingLog row/i.test(result.reason));
      const after = await prisma.ticket.findUnique({ where: { id: ticket.id }, select: { description: true } });
      check("D3: Ticket.description unchanged after the aborted apply attempt", after?.description === flattened);
    }

    // ── E — a non-EMAIL-source ticket is rejected outright ────────────────
    console.log("\nE — a WEB-source ticket is rejected outright, zero writes, zero Graph calls...\n");
    {
      const requester = await prisma.user.create({ data: { email: `req-${RUN_ID}-web@example.com`, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
      userIds.push(requester.id);
      const webTicket = await prisma.ticket.create({
        data: {
          title: "A normal web-created ticket",
          description: "Some web-created description.",
          source: "WEB",
          requesterId: requester.id,
          departmentId: dept.id,
          statusId: (await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id } })).id,
        },
      });
      ticketIds.push(webTicket.id);

      const callsBefore = graphCalls.length;
      const result = await repairTicket(webTicket.ticketNumber, true);
      check("E: WEB-source ticket result is NOT ok", result.ok === false);
      if (!result.ok) check("E: reason mentions source is not EMAIL", /not EMAIL/i.test(result.reason));
      check("E: no Graph call was even attempted", graphCalls.length === callsBefore);
      const after = await prisma.ticket.findUnique({ where: { id: webTicket.id }, select: { description: true } });
      check("E: Ticket.description unchanged", after?.description === "Some web-created description.");
    }

    // ── Bonus — the --pending path verifies identity the same way ─────────
    console.log("\nBonus — repairPending() recovers a still-pending row and verifies message identity the same way...\n");
    {
      const emailMessageId = `<legacy-${RUN_ID}-pending@test.local>`;
      const flattened = flattenedLegacyBody(RUN_ID, "pendingonly");
      const log = await prisma.emailProcessingLog.create({
        data: { runId: `run-${RUN_ID}-pendingonly`, mailbox: MAILBOX, messageId: emailMessageId, fromEmail: `sender-${RUN_ID}@example.com`, subject: "Recovery test pendingonly", action: "CREATED_TICKET" },
      });
      logIds.push(log.id);
      const pending = await prisma.pendingTicket.create({
        data: { emailMessageId, fromEmail: `sender-${RUN_ID}@example.com`, fromName: "Original Sender", subject: "Recovery test pendingonly", body: flattened, receivedAt: new Date(), departmentId: dept.id },
      });
      pendingTicketIds.push(pending.id);
      mockedMessages.set(emailMessageId, makeGraphMessage(RUN_ID, "pendingonly", emailMessageId));

      const dryRun = await repairPending(pending.id, false);
      check("Bonus: pending dry-run is ok and reports a change", dryRun.ok === true && dryRun.ok && dryRun.changes[0].changed && !dryRun.wrote);
      const unchanged = await prisma.pendingTicket.findUnique({ where: { id: pending.id }, select: { body: true } });
      check("Bonus: pending body unchanged after dry-run", unchanged?.body === flattened);

      const apply = await repairPending(pending.id, true);
      check("Bonus: pending apply is ok and wrote", apply.ok === true && apply.ok && apply.wrote);
      const after = await prisma.pendingTicket.findUnique({ where: { id: pending.id }, select: { body: true } });
      check("Bonus: pending body now holds readable, row-separated recovered text", (after?.body ?? "").includes(`From: Original Sender pendingonly <sender-${RUN_ID}@example.com>`));

      const secondApply = await repairPending(pending.id, true);
      check("Bonus: second pending apply is idempotent (no write)", secondApply.ok === true && secondApply.ok && !secondApply.wrote);
    }
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["ticketMessages", () => prisma.ticketMessage.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["ticketHistory", () => prisma.ticketHistory.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["pendingTickets", () => prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } })],
      ["emailProcessingLogs", () => prisma.emailProcessingLog.deleteMany({ where: { id: { in: logIds } } })],
      ["departmentMemberships", () => prisma.departmentMembership.deleteMany({ where: { userId: { in: userIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticketStatuses", () => (dept ? prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["ticketPriorities", () => (dept ? prisma.ticketPriority.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.delete({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, step] of cleanupSteps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

/** What htmlToReadableText (the current, fixed converter) produces for originalHtml() above — computed via the SAME production function the repair script itself calls, never a hand-maintained duplicate expectation. */
async function originalHtmlToExpectedText(runId: number, tag: string): Promise<string> {
  const { htmlToReadableText } = await import("@/lib/email-ticket-parser");
  return htmlToReadableText(originalHtml(runId, tag));
}

main();
