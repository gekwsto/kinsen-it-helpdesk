/**
 * Inbound email no longer creates a Ticket directly — matchDepartmentForRecipients
 * + createPendingTicketFromEmail (lib/services/pending-ticket-service.ts) are
 * what processInboundEmails now calls for any new thread. This test
 * exercises both functions directly against real Prisma data, mirroring
 * exactly what the pipeline does.
 *
 * Tests:
 *  1. A recipient address matching a configured Department.inboundEmail
 *     resolves that department.
 *  2. A recipient address matching no department resolves null.
 *  3. createPendingTicketFromEmail with a matched department creates a
 *     PendingTicket with that departmentId, status PENDING.
 *  4. createPendingTicketFromEmail with department: null creates a
 *     PendingTicket with departmentId: null (not silently dropped, not
 *     assigned to a guessed department).
 *  5. The requester is found-or-created by fromEmail (a second call with the
 *     same fromEmail reuses the same User row, not a duplicate).
 *  6. emailMessageId is a real DB-unique constraint — creating a second
 *     PendingTicket with the same emailMessageId throws (the exact
 *     protection processInboundEmails' dedup check exists to avoid tripping).
 *
 * Usage: npx tsx scripts/test-pending-ticket-email-routing.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import { prisma } from "@/lib/prisma";
import type { ParsedEmail } from "@/lib/email-ticket-parser";
import { matchDepartmentForRecipients, createPendingTicketFromEmail } from "@/lib/services/pending-ticket-service";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function makeParsedEmail(overrides: Partial<ParsedEmail>): ParsedEmail {
  const now = new Date();
  return {
    subject: "Test Subject",
    fromEmail: `test-sender-${Date.now()}@example.com`,
    fromName: "Test Sender",
    bodyHtml: "<p>Test body</p>",
    bodyText: "Test body",
    attachments: [],
    messageId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    conversationId: `conv-${Date.now()}`,
    receivedAt: now,
    existingTicketNumber: null,
    internetMessageHeaders: [],
    toEmails: [],
    ...overrides,
  };
}

const RUN_ID = Date.now();

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  try {
    await prisma.pendingTicket.count();
  } catch (err) {
    console.log(
      "PendingTicket isn't usable against this database yet (migration " +
        "20260724090000_add_department_inbound_email_and_pending_tickets not applied) — skipping. " +
        "Run `npx prisma migrate deploy` (or `migrate dev`) first."
    );
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  let dept: { id: string } | undefined;
  const pendingTicketIds: string[] = [];
  const userEmails: string[] = [];

  try {
    console.log("\nSetting up a department with an inbound email...\n");
    const inboundEmail = `routing-test-${RUN_ID}@kinsen.gr`;
    dept = await prisma.department.create({
      data: { name: `Routing Dept ${RUN_ID}`, slug: `routing-dept-${RUN_ID}`, inboundEmail },
      select: { id: true },
    });

    console.log("\nTesting department matching...\n");
    const matched = await matchDepartmentForRecipients(["someone-else@kinsen.gr", inboundEmail.toUpperCase()]);
    check("A recipient matching the department's inboundEmail resolves it (case-insensitive)", matched?.id === dept.id);

    const unmatched = await matchDepartmentForRecipients([`nobody-${RUN_ID}@kinsen.gr`]);
    check("A recipient matching no department resolves null", unmatched === null);

    console.log("\nTesting PendingTicket creation with a matched department...\n");
    const senderEmail = `routing-sender-${RUN_ID}@example.com`;
    userEmails.push(senderEmail);
    const parsed1 = makeParsedEmail({ fromEmail: senderEmail, toEmails: [inboundEmail] });
    const pending1 = await createPendingTicketFromEmail(parsed1, dept);
    pendingTicketIds.push(pending1.id);

    const fetched1 = await prisma.pendingTicket.findUnique({ where: { id: pending1.id } });
    check("PendingTicket created with the matched departmentId", fetched1?.departmentId === dept.id);
    check("PendingTicket status defaults to PENDING", fetched1?.status === "PENDING");

    console.log("\nTesting PendingTicket creation with no matched department (departmentId: null)...\n");
    const parsed2 = makeParsedEmail({ fromEmail: senderEmail, toEmails: [] });
    const pending2 = await createPendingTicketFromEmail(parsed2, null);
    pendingTicketIds.push(pending2.id);

    const fetched2 = await prisma.pendingTicket.findUnique({ where: { id: pending2.id } });
    check("Unmatched email creates a PendingTicket with departmentId: null (not dropped, not guessed)", fetched2?.departmentId === null);

    console.log("\nTesting requester find-or-create by fromEmail...\n");
    check("Both pending tickets from the same sender share one requesterId (no duplicate User created)", fetched1?.requesterId === fetched2?.requesterId);
    const requesterCount = await prisma.user.count({ where: { email: senderEmail } });
    check("Exactly one User row exists for the sender email", requesterCount === 1);

    console.log("\nTesting emailMessageId is a real unique constraint...\n");
    const dupeMessageId = parsed1.messageId;
    let threw = false;
    try {
      await prisma.pendingTicket.create({
        data: {
          emailMessageId: dupeMessageId,
          fromEmail: senderEmail,
          subject: "Duplicate attempt",
          body: "x",
          receivedAt: new Date(),
        },
      });
    } catch {
      threw = true;
    }
    check("Creating a second PendingTicket with the same emailMessageId throws (DB-unique)", threw);
  } finally {
    console.log("\nCleaning up test data...\n");
    const cleanupSteps: Array<[string, () => Promise<unknown>]> = [
      ["pendingTickets", () => prisma.pendingTicket.deleteMany({ where: { id: { in: pendingTicketIds } } })],
      ["users", () => (userEmails.length > 0 ? prisma.user.deleteMany({ where: { email: { in: userEmails } } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
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

main();
