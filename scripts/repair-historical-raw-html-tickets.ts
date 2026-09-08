/**
 * Repairs already-accepted Tickets that still hold raw email HTML in
 * Ticket.description and/or a TicketMessage.body — the historical blast
 * radius of BUG 1 (see the email-ingestion fix's own report), reproduced in
 * the real UI as KIN-587 before this fix existed. This script is the tool
 * for cleaning up rows that were ALREADY WRITTEN before both the ingestion-
 * time fix (lib/email-ticket-parser.ts) and the accept-time defense-in-depth
 * normalization (lib/services/pending-ticket-service.ts's acceptPendingTicket)
 * — neither of those touches data already sitting in the database.
 *
 * SCOPE — deliberately conservative, never "normalize every Ticket
 * description":
 *   Section A: Tickets with source: EMAIL — checks Ticket.description AND
 *     that specific ticket's INITIAL TicketMessage (the one
 *     acceptPendingTicket creates, identified the same way ticket-thread.tsx
 *     used to for its now-removed dangerouslySetInnerHTML branch: direction
 *     INBOUND, not internal, fromEmail set, earliest by createdAt).
 *   Section B: ANY TicketMessage (on a Ticket of ANY source — a WEB ticket
 *     can receive an emailed-in reply too) with fromEmail set — the
 *     reply-append path (lib/ticket-email-service.ts's appendEmailReply) had
 *     the exact same raw-HTML bug before this fix.
 * A row is only ever a "candidate" if lib/email-ticket-parser.ts's
 * looksLikeHtml() — the SAME detector normalizeStoredEmailBody uses at the
 * accept boundary — returns true for that specific field. Every other field
 * (title, requester, department, etc.) is never touched.
 *
 * SAFETY
 *   - --dry-run is the DEFAULT (also true with no flags) — reports
 *     candidates and what would change, writes nothing.
 *   - --apply is required to actually update rows.
 *   - Normalizes with lib/email-ticket-parser.ts's htmlToReadableText — the
 *     exact same function used for every new/accepted email — never a
 *     separate implementation.
 *   - Updates ONLY the specific field(s) proven to look like HTML on that
 *     row (description and/or that one message's body) — a ticket whose
 *     description is already clean but whose initial message still has raw
 *     HTML gets ONLY the message fixed, and vice versa.
 *   - Idempotent: re-running in --apply mode after a successful run finds
 *     zero candidates (looksLikeHtml is false on the now-clean text), so it
 *     is always safe to run again.
 *   - Never invoked automatically (no startup hook, no cron, no request
 *     handler calls this) — purely an operator-run tool. This task runs it
 *     ONLY in --dry-run mode against the available dev/test database; no
 *     --apply run is performed as part of this work.
 *
 * Usage:
 *   npx tsx scripts/repair-historical-raw-html-tickets.ts            # dry run (default)
 *   npx tsx scripts/repair-historical-raw-html-tickets.ts --dry-run  # same, explicit
 *   npx tsx scripts/repair-historical-raw-html-tickets.ts --apply    # actually updates rows
 */
import { prisma } from "@/lib/prisma";
import { htmlToReadableText, looksLikeHtml } from "@/lib/email-ticket-parser";
import { formatTicketNumber } from "@/lib/utils";

function preview(text: string, n = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const explicitDryRun = args.includes("--dry-run");
  if (apply && explicitDryRun) {
    console.error("Pass either --apply or --dry-run, not both.");
    process.exit(1);
  }
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`\n=== Historical raw-HTML repair — ${mode} ===\n`);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  let ticketsChanged = 0;
  let descriptionsFixed = 0;
  let messagesFixed = 0;

  // ── Section A: EMAIL-source tickets — description + initial message ──
  console.log("── Section A: source: EMAIL tickets (description + initial message) ──\n");
  const emailTickets = await prisma.ticket.findMany({
    where: { source: "EMAIL" },
    select: { id: true, ticketNumber: true, title: true, description: true, source: true },
  });

  for (const ticket of emailTickets) {
    const initialMessage = await prisma.ticketMessage.findFirst({
      where: { ticketId: ticket.id, direction: "INBOUND", isInternal: false, fromEmail: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { id: true, body: true },
    });

    const descriptionIsHtml = looksLikeHtml(ticket.description);
    const messageIsHtml = initialMessage ? looksLikeHtml(initialMessage.body) : false;

    if (!descriptionIsHtml && !messageIsHtml) continue;

    const ref = formatTicketNumber(ticket.ticketNumber);
    console.log(`Candidate: [${ref}] ${ticket.id} — "${ticket.title}"`);
    console.log(`  source: ${ticket.source}`);
    console.log(`  Ticket.description looks like HTML: ${descriptionIsHtml}`);
    if (descriptionIsHtml) {
      console.log(`    before: ${preview(ticket.description)}`);
      console.log(`    after:  ${preview(htmlToReadableText(ticket.description))}`);
    }
    console.log(`  initial TicketMessage.body looks like HTML: ${messageIsHtml} ${initialMessage ? `(message ${initialMessage.id})` : "(no email-provenance initial message found)"}`);
    if (messageIsHtml && initialMessage) {
      console.log(`    before: ${preview(initialMessage.body)}`);
      console.log(`    after:  ${preview(htmlToReadableText(initialMessage.body))}`);
    }

    if (apply) {
      if (descriptionIsHtml) {
        await prisma.ticket.update({ where: { id: ticket.id }, data: { description: htmlToReadableText(ticket.description) } });
        descriptionsFixed++;
      }
      if (messageIsHtml && initialMessage) {
        await prisma.ticketMessage.update({ where: { id: initialMessage.id }, data: { body: htmlToReadableText(initialMessage.body) } });
        messagesFixed++;
      }
      ticketsChanged++;
    }
    console.log();
  }

  // ── Section B: any email-provenance TicketMessage (reply included) ────
  console.log("── Section B: any TicketMessage with fromEmail set, on a ticket of ANY source ──\n");
  const emailMessages = await prisma.ticketMessage.findMany({
    where: { fromEmail: { not: null } },
    select: { id: true, ticketId: true, body: true, ticket: { select: { ticketNumber: true, source: true } } },
  });

  let sectionBCandidates = 0;
  for (const msg of emailMessages) {
    if (!looksLikeHtml(msg.body)) continue;
    sectionBCandidates++;
    const ref = formatTicketNumber(msg.ticket.ticketNumber);
    console.log(`Candidate: [${ref}] message ${msg.id} — ticket source: ${msg.ticket.source}`);
    console.log(`    before: ${preview(msg.body)}`);
    console.log(`    after:  ${preview(htmlToReadableText(msg.body))}`);
    if (apply) {
      await prisma.ticketMessage.update({ where: { id: msg.id }, data: { body: htmlToReadableText(msg.body) } });
      messagesFixed++;
    }
    console.log();
  }

  console.log(`=== Summary (${mode}) ===`);
  console.log(`Section A candidates (EMAIL-source tickets with HTML in description and/or initial message): ${emailTickets.length} tickets scanned`);
  console.log(`Section B candidates (any HTML-looking email-provenance message body):                       ${sectionBCandidates} messages scanned`);
  if (apply) {
    console.log(`Descriptions fixed: ${descriptionsFixed}`);
    console.log(`Messages fixed:     ${messagesFixed}`);
  } else {
    console.log("\nThis was a dry run — nothing was written. Re-run with --apply to update the rows listed above.");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
