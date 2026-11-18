/**
 * Focused regression for the `--dry-run` / inventory feature added to
 * scripts/diagnose-attachment-graph-recovery.ts in response to a FOURTH
 * real production run that hit its --limit before classifying every row.
 * Since every run re-derives its message groups from scratch (no cross-run
 * memory of which messages were already looked up), the next --limit value
 * must be CONFIRMED, not guessed. `--dry-run` runs Passes 1-2 only (local
 * file checks + DB reads) and must NEVER call Microsoft Graph — this test
 * proves that directly, by counting real invocations of the mocked
 * microsoftGraph client, not just by inspecting console output.
 *
 * Fixtures build a known, small inventory so the reported counts can be
 * asserted exactly:
 *   - 2 TicketAttachment rows sharing ONE emailMessageId + ONE resolved
 *     mailbox -> 1 distinct message group covering 2 rows.
 *   - 1 TicketAttachment row with its OWN distinct emailMessageId/mailbox
 *     -> a second distinct message group covering 1 row.
 *   - 1 row with no emailMessageId at all -> no_email_correlation (must
 *     NOT count toward the distinct-group total).
 *   - 1 row whose emailMessageId resolves to TWO distinct mailboxes via
 *     EmailProcessingLog -> mailbox_unresolved (must NOT count either).
 *   - 1 row whose bytes already exist in local storage (a real file is
 *     written under UPLOAD_DIR for this) -> file_present, resolved in
 *     Pass 1 before any email/mailbox resolution is even attempted.
 *
 * Expected dry-run report: 6 total rows, 1 file_present, 1
 * no_email_correlation, 1 mailbox_unresolved, 3 rows requiring a Graph
 * lookup, 2 distinct message groups required — and ZERO Graph calls.
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-attachment-graph-recovery-dry-run.ts
 */
import fs from "fs/promises";
import path from "path";
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { UPLOAD_DIR } from "@/lib/attachment-policy";
import { Role, AuthProvider, TicketSource } from "@prisma/client";

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
const TAG = `gdryrun-${RUN_ID}`;

let graphCallCount = 0;
mock.module("@/lib/microsoft-graph", {
  namedExports: {
    GraphConfigurationError: class GraphConfigurationError extends Error {},
    microsoftGraph: {
      getMessageByInternetMessageId: async (_mailbox: string, emailMessageId: string) => {
        // A dry run must NEVER reach this — if it does, fail loudly via the
        // counter below rather than throwing, so the test can report a
        // clean assertion failure instead of an uncaught exception.
        graphCallCount++;
        return { internetMessageId: emailMessageId, attachments: [] };
      },
    },
  },
});

async function main() {
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
  const attachmentIds: string[] = [];
  const logIds: string[] = [];
  let filePresentDir: string | null = null;

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
    const user = await prisma.user.create({ data: { email: `${TAG}-user@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    userIds.push(user.id);

    const makeTicket = async (emailMessageId: string | null) => {
      const ticket = await prisma.ticket.create({
        data: { title: `${TAG} ticket`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id, emailMessageId },
      });
      ticketIds.push(ticket.id);
      return ticket;
    };
    const makeAttachment = async (ticketId: string, originalName: string, filename: string) => {
      const attachment = await prisma.ticketAttachment.create({
        data: { ticketId, uploadedById: user.id, filename, originalName, mimeType: "image/png", size: 10, path: "/x" },
      });
      attachmentIds.push(attachment.id);
      return attachment;
    };

    // ── Group 1: two attachment ROWS on the SAME ticket (ticket-level,
    //    messageId: null) both resolving to that one ticket's single
    //    emailMessageId — Ticket.emailMessageId is itself DB-unique, so two
    //    DIFFERENT tickets can never share one; the realistic way two rows
    //    share one message is two attachments on the SAME creating email.
    //    1 distinct group, 2 rows. ──
    const sharedMsgId = `<${TAG}-shared@example.com>`;
    const sharedMailbox = `${TAG}-shared-mb@example.com`;
    const ticketShared = await makeTicket(sharedMsgId);
    await makeAttachment(ticketShared.id, "a.png", `${TAG}-a.bin`);
    await makeAttachment(ticketShared.id, "b.png", `${TAG}-b.bin`);
    const logShared = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: sharedMsgId, action: "CREATED_TICKET", mailbox: sharedMailbox } });
    logIds.push(logShared.id);

    // ── Group 2: its own distinct message (a second distinct group, 1 row). ──
    const soloMsgId = `<${TAG}-solo@example.com>`;
    const soloMailbox = `${TAG}-solo-mb@example.com`;
    const ticketSolo = await makeTicket(soloMsgId);
    await makeAttachment(ticketSolo.id, "c.png", `${TAG}-c.bin`);
    const logSolo = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: soloMsgId, action: "CREATED_TICKET", mailbox: soloMailbox } });
    logIds.push(logSolo.id);

    // ── No email correlation at all. ──
    const ticketNoCorrelation = await makeTicket(null);
    await makeAttachment(ticketNoCorrelation.id, "d.png", `${TAG}-d.bin`);

    // ── Mailbox unresolved: same messageId, TWO distinct mailboxes. ──
    const ambiguousMsgId = `<${TAG}-ambiguous-mailbox@example.com>`;
    const ticketAmbiguousMailbox = await makeTicket(ambiguousMsgId);
    await makeAttachment(ticketAmbiguousMailbox.id, "e.png", `${TAG}-e.bin`);
    const logAmbig1 = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: ambiguousMsgId, action: "CREATED_TICKET", mailbox: `${TAG}-mb-1@example.com` } });
    const logAmbig2 = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: ambiguousMsgId, action: "CREATED_TICKET", mailbox: `${TAG}-mb-2@example.com` } });
    logIds.push(logAmbig1.id, logAmbig2.id);

    // ── File already present locally — resolved in Pass 1, no email/mailbox
    //    resolution even attempted, must never count toward the Graph
    //    budget at all. ──
    const ticketFilePresent = await makeTicket(`<${TAG}-file-present@example.com>`);
    const filePresentFilename = `${TAG}-present.bin`;
    const filePresentAttachment = await makeAttachment(ticketFilePresent.id, "f.png", filePresentFilename);
    filePresentDir = path.join(UPLOAD_DIR, ticketFilePresent.id);
    await fs.mkdir(filePresentDir, { recursive: true });
    await fs.writeFile(path.join(filePresentDir, filePresentFilename), "test content");
    void filePresentAttachment;

    // Inject --dry-run into argv BEFORE importing — main() reads
    // process.argv synchronously at call time, and the diagnostic module
    // calls main() itself on import.
    process.argv.push("--dry-run");

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      lines.push(line);
      originalLog(...args);
    };

    try {
      await import("@/scripts/diagnose-attachment-graph-recovery");
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");

    check("Dry run made ZERO Microsoft Graph requests", graphCallCount === 0, `graphCallCount=${graphCallCount}`);
    check("Output announces a dry run", output.includes("DRY RUN"));
    check("Output never reaches Pass 3's own report line", !output.includes("Graph requests made this run"));
    check("file_present row excluded before any email/mailbox resolution", /Already present locally \(file_present\):\s+1/.test(output));
    check("No-correlation row counted correctly", /No email correlation \(not email-ingested\):\s+1/.test(output));
    check("Mailbox-unresolved row counted correctly", /Mailbox unresolved \(0 or 2\+ distinct mailboxes\):\s+1/.test(output));
    check("Rows requiring a Graph lookup counted correctly (2 shared + 1 solo = 3)", /Rows requiring a Graph lookup:\s+3/.test(output));
    check("Distinct message groups required is exactly 2 (1 shared group + 1 solo group)", /Distinct \(mailbox, emailMessageId\) groups required:\s+2/.test(output));
    check("Required --limit is reported as exactly 2", /Required --limit for a complete single-pass run:\s+2/.test(output));
  } finally {
    const idx = process.argv.indexOf("--dry-run");
    if (idx !== -1) process.argv.splice(idx, 1);

    console.log("\nCleaning up test data...\n");
    try {
      if (filePresentDir) await fs.rm(filePresentDir, { recursive: true, force: true });
      await prisma.emailProcessingLog.deleteMany({ where: { id: { in: logIds } } });
      await prisma.ticketAttachment.deleteMany({ where: { id: { in: attachmentIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
