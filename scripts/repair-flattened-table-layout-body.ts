/**
 * Recovers the EXACT original formatting for ONE specific Ticket or
 * PendingTicket whose stored body was flattened by the pre-fix table-layout
 * bug (KIN-595 — see lib/email-ticket-parser.ts's htmlToReadableText doc
 * comment). Unlike scripts/repair-historical-raw-html-tickets.ts (a
 * different, earlier bug: raw HTML literally surviving in a stored field,
 * detectable via looksLikeHtml()), a KIN-595-flattened body is ALREADY
 * clean plain text — no HTML tag survives, so there is no reliable way to
 * detect or repair it from the stored text alone. The only way to recover
 * the true original layout is to re-fetch the ORIGINAL email from Graph
 * (via the record's own emailMessageId) and re-run it through the NOW-FIXED
 * canonical converter — which is exactly, and only, what this script does.
 *
 * This is deliberately NOT a bulk scanner. There is no reliable signal in
 * already-flattened plain text that distinguishes "this came from a table
 * that got flattened" from "this was always written as one line" — guessing
 * would risk rewriting rows that were never affected. So this script only
 * ever touches ONE record, named explicitly by the caller.
 *
 * repairTicket()/repairPending() below are exported (in addition to being
 * runnable as a CLI script) so scripts/test-repair-flattened-table-layout-body.ts
 * can exercise the exact same logic this file's `main()` runs, against a
 * mocked Graph client — one implementation, both a real operator tool and a
 * regression-tested one, never two copies that could drift.
 *
 * WHAT --ticket=<number> DOES
 *   1. Loads the Ticket and requires source: "EMAIL" and a non-null
 *      emailMessageId — a WEB/INTEGRATION-source ticket, or an EMAIL ticket
 *      somehow missing its emailMessageId, is rejected outright: there is no
 *      original inbound email to re-fetch.
 *   2. Resolves EXACTLY ONE source mailbox from EmailProcessingLog rows
 *      matching that emailMessageId. Zero matching mailboxes, or more than
 *      one DISTINCT mailbox recorded for the same messageId (a genuinely
 *      ambiguous case), aborts with no writes.
 *   3. Re-fetches that exact message from Graph by internetMessageId
 *      (microsoftGraph.getMessageByInternetMessageId — searches the whole
 *      mailbox, not just "Processed", so it still finds the message even if
 *      it was later moved/filed elsewhere) — read-only: never marks the
 *      message read and never moves it.
 *   4. Verifies the message Graph returned actually carries the SAME
 *      internetMessageId that was asked for — a defensive check against a
 *      mismatched/wrong message ever being trusted, even if Graph's own
 *      $filter behaved unexpectedly.
 *   5. Finds the ticket's initial TicketMessage by an EXACT emailMessageId
 *      match (never a heuristic like "earliest inbound message") — this is
 *      "that exact message," never a later reply or an internal/user-authored
 *      message. If no TicketMessage carries that exact emailMessageId, this
 *      is treated as a missing match and the whole operation aborts.
 *   6. Finds the PendingTicket that was ACCEPTED INTO this exact ticket (by
 *      emailMessageId match AND acceptedTicketId === this ticket's id) if
 *      one still exists — optional; its absence is not an abort condition
 *      (a PendingTicket row can be deleted/retention-purged independently).
 *   7. Re-parses the fetched message with the SAME parseIncomingEmail /
 *      htmlToReadableText this app uses for every new email.
 *   8. With --apply only: writes the recovered text into Ticket.description,
 *      the matching initial TicketMessage.body, and (if found) the
 *      originating PendingTicket.body — all three in ONE Prisma transaction,
 *      each field only if its current value actually differs from the
 *      recovered text. No later reply, no internal note, no other ticket is
 *      ever touched.
 *
 * WHAT --pending=<id> DOES: the same mailbox-resolution + Graph re-fetch +
 * identity verification, then updates only that exact PendingTicket.body.
 *
 * SAFETY
 *   - --dry-run is the DEFAULT (also true with no flags) — never writes.
 *   - --apply is required to actually update anything.
 *   - Exactly one of --ticket=<number> or --pending=<id> is required.
 *   - Idempotent: re-running after a successful apply reports every field
 *     already matching and writes nothing.
 *   - Never invoked automatically — purely an operator-run tool, one record
 *     at a time, with a visible before/after for manual review.
 *
 * Usage:
 *   npx tsx scripts/repair-flattened-table-layout-body.ts --ticket=595
 *   npx tsx scripts/repair-flattened-table-layout-body.ts --ticket=595 --apply
 *   npx tsx scripts/repair-flattened-table-layout-body.ts --pending=<pendingTicketId>
 *   npx tsx scripts/repair-flattened-table-layout-body.ts --pending=<pendingTicketId> --apply
 */
import { prisma } from "@/lib/prisma";
import { parseIncomingEmail } from "@/lib/email-ticket-parser";
import { formatTicketNumber } from "@/lib/utils";
import { microsoftGraph } from "@/lib/microsoft-graph";
import type { PrismaClient } from "@prisma/client";

export interface FieldChange {
  field: "Ticket.description" | "TicketMessage.body" | "PendingTicket.body";
  id: string;
  before: string;
  after: string;
  changed: boolean;
}

export type RepairResult =
  | { ok: false; reason: string }
  | { ok: true; mailbox: string; changes: FieldChange[]; applied: boolean; wrote: boolean };

/** Exactly one distinct mailbox, or an explicit failure reason — never silently picks "the most recent" among several conflicting candidates. */
async function resolveSourceMailbox(client: PrismaClient, emailMessageId: string): Promise<{ ok: true; mailbox: string } | { ok: false; reason: string }> {
  const logs = await client.emailProcessingLog.findMany({
    where: { messageId: emailMessageId, mailbox: { not: null } },
    select: { mailbox: true },
  });
  const distinct = [...new Set(logs.map((l) => l.mailbox!))];
  if (distinct.length === 0) {
    return { ok: false, reason: `No EmailProcessingLog row records which mailbox message ${emailMessageId} came from — cannot determine which Graph mailbox to query.` };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: `Ambiguous: ${distinct.length} different mailboxes are recorded for message ${emailMessageId} (${distinct.join(", ")}) — cannot determine a single source mailbox.`,
    };
  }
  return { ok: true, mailbox: distinct[0] };
}

/** Fetches the message and verifies Graph actually returned the SAME internetMessageId that was asked for. */
async function fetchVerifiedMessage(mailbox: string, emailMessageId: string) {
  const message = await microsoftGraph.getMessageByInternetMessageId(mailbox, emailMessageId);
  if (!message) {
    return { ok: false as const, reason: `Graph has no message with internetMessageId ${emailMessageId} in mailbox ${mailbox} (deleted, or purged by mailbox retention).` };
  }
  if (message.internetMessageId !== emailMessageId) {
    return {
      ok: false as const,
      reason: `Graph returned a message with a different internetMessageId than requested (expected ${emailMessageId}, got ${message.internetMessageId}) — refusing to use a mismatched message.`,
    };
  }
  return { ok: true as const, message };
}

/**
 * Repairs ONE Ticket (by ticket number). `client` defaults to the shared
 * prisma singleton — overridable so a test can pass a transaction client,
 * though tests here just use the same singleton the app does.
 */
export async function repairTicket(ticketNumber: number, apply: boolean, client: PrismaClient = prisma): Promise<RepairResult> {
  const ticket = await client.ticket.findUnique({
    where: { ticketNumber },
    select: { id: true, ticketNumber: true, title: true, source: true, description: true, emailMessageId: true },
  });
  if (!ticket) return { ok: false, reason: `No Ticket found with ticketNumber ${ticketNumber}.` };
  if (ticket.source !== "EMAIL") return { ok: false, reason: `Ticket ${formatTicketNumber(ticket.ticketNumber)} has source: ${ticket.source}, not EMAIL — there is no original inbound email to recover.` };
  if (!ticket.emailMessageId) return { ok: false, reason: `Ticket ${formatTicketNumber(ticket.ticketNumber)} has no emailMessageId recorded — nothing to recover.` };

  const mailboxResult = await resolveSourceMailbox(client, ticket.emailMessageId);
  if (!mailboxResult.ok) return mailboxResult;

  const fetched = await fetchVerifiedMessage(mailboxResult.mailbox, ticket.emailMessageId);
  if (!fetched.ok) return fetched;

  // "That exact message" — an EXACT emailMessageId match, never a heuristic
  // like "the earliest inbound message on this ticket." A later reply or an
  // internal/user-authored TicketMessage never carries this emailMessageId,
  // so it can never be matched or touched here.
  const initialMessage = await client.ticketMessage.findFirst({
    where: { ticketId: ticket.id, emailMessageId: ticket.emailMessageId },
    select: { id: true, body: true },
  });
  if (!initialMessage) {
    return { ok: false, reason: `No TicketMessage on ${formatTicketNumber(ticket.ticketNumber)} has emailMessageId ${ticket.emailMessageId} — cannot identify the exact initial message to update.` };
  }

  // The PendingTicket that was accepted INTO this exact ticket, if it still
  // exists — optional, never required for the repair to proceed.
  const originPending = await client.pendingTicket.findFirst({
    where: { emailMessageId: ticket.emailMessageId, acceptedTicketId: ticket.id },
    select: { id: true, body: true },
  });

  const parsed = parseIncomingEmail(fetched.message);
  const changes: FieldChange[] = [
    { field: "Ticket.description", id: ticket.id, before: ticket.description, after: parsed.bodyText, changed: ticket.description !== parsed.bodyText },
    { field: "TicketMessage.body", id: initialMessage.id, before: initialMessage.body, after: parsed.bodyText, changed: initialMessage.body !== parsed.bodyText },
  ];
  if (originPending) {
    changes.push({ field: "PendingTicket.body", id: originPending.id, before: originPending.body, after: parsed.bodyText, changed: originPending.body !== parsed.bodyText });
  }

  let wrote = false;
  if (apply) {
    const toWrite = changes.filter((c) => c.changed);
    if (toWrite.length > 0) {
      // All related writes for this one message commit together or not at all.
      await client.$transaction(async (tx) => {
        for (const change of toWrite) {
          if (change.field === "Ticket.description") await tx.ticket.update({ where: { id: change.id }, data: { description: change.after } });
          if (change.field === "TicketMessage.body") await tx.ticketMessage.update({ where: { id: change.id }, data: { body: change.after } });
          if (change.field === "PendingTicket.body") await tx.pendingTicket.update({ where: { id: change.id }, data: { body: change.after } });
        }
      });
      wrote = true;
    }
  }

  return { ok: true, mailbox: mailboxResult.mailbox, changes, applied: apply, wrote };
}

/** Repairs ONE PendingTicket (by id). */
export async function repairPending(pendingId: string, apply: boolean, client: PrismaClient = prisma): Promise<RepairResult> {
  const pending = await client.pendingTicket.findUnique({
    where: { id: pendingId },
    select: { id: true, subject: true, body: true, emailMessageId: true },
  });
  if (!pending) return { ok: false, reason: `No PendingTicket found with id ${pendingId}.` };

  const mailboxResult = await resolveSourceMailbox(client, pending.emailMessageId);
  if (!mailboxResult.ok) return mailboxResult;

  const fetched = await fetchVerifiedMessage(mailboxResult.mailbox, pending.emailMessageId);
  if (!fetched.ok) return fetched;

  const parsed = parseIncomingEmail(fetched.message);
  const changes: FieldChange[] = [{ field: "PendingTicket.body", id: pending.id, before: pending.body, after: parsed.bodyText, changed: pending.body !== parsed.bodyText }];

  let wrote = false;
  if (apply && changes[0].changed) {
    await client.$transaction(async (tx) => {
      await tx.pendingTicket.update({ where: { id: pending.id }, data: { body: parsed.bodyText } });
    });
    wrote = true;
  }

  return { ok: true, mailbox: mailboxResult.mailbox, changes, applied: apply, wrote };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const explicitDryRun = argv.includes("--dry-run");
  if (apply && explicitDryRun) {
    console.error("Pass either --apply or --dry-run, not both.");
    process.exit(1);
  }
  const ticketArg = argv.find((a) => a.startsWith("--ticket="));
  const pendingArg = argv.find((a) => a.startsWith("--pending="));
  if (!!ticketArg === !!pendingArg) {
    console.error("Pass exactly one of --ticket=<number> or --pending=<pendingTicketId>.");
    process.exit(1);
  }
  const ticketNumber = ticketArg ? Number(ticketArg.slice("--ticket=".length)) : null;
  if (ticketArg && (!Number.isInteger(ticketNumber) || ticketNumber! <= 0)) {
    console.error(`Invalid --ticket value: ${ticketArg}`);
    process.exit(1);
  }
  const pendingId = pendingArg ? pendingArg.slice("--pending=".length) : null;
  return { apply, ticketNumber, pendingId };
}

function printChange(change: FieldChange) {
  console.log(`\n--- ${change.field} (${change.id}): CURRENT (stored) ---`);
  console.log(change.before);
  console.log(`\n--- ${change.field} (${change.id}): RECOVERED (from original Graph HTML, re-parsed with the current fix) ---`);
  console.log(change.after);
  console.log(change.changed ? "(DIFFERS from what is currently stored)" : "(identical — no change needed)");
}

async function main() {
  const { apply, ticketNumber, pendingId } = parseArgs(process.argv.slice(2));
  const mode = apply ? "APPLY" : "DRY RUN";
  console.log(`\n=== Flattened table-layout body recovery (KIN-595) — ${mode} ===\n`);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  try {
    const result = ticketNumber !== null ? await repairTicket(ticketNumber, apply) : await repairPending(pendingId!, apply);

    if (!result.ok) {
      console.log(result.reason);
      process.exitCode = 1;
      return;
    }

    console.log(`Source mailbox (from EmailProcessingLog): ${result.mailbox}`);
    for (const change of result.changes) printChange(change);

    if (apply) {
      console.log(result.wrote ? "\nUpdated the field(s) listed above as DIFFERS, in one transaction." : "\nNothing to write — every field already matched the recovered text.");
    } else {
      console.log("\nThis was a dry run — nothing was written. Re-run with --apply to update.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only run the CLI when this file is executed directly, not when
// repairTicket/repairPending are imported by the test suite.
if (require.main === module) {
  main();
}
