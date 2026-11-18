/**
 * READ-ONLY diagnostic: for every TicketAttachment/PendingTicketAttachment
 * row, reports whether its bytes are already present in local storage, and
 * if not, whether they're recoverable from Microsoft Graph by re-fetching
 * the original email.
 *
 * Does NOT recover anything. Does NOT write to the database. Does NOT
 * create, move, or mark-read any email or message. Does NOT copy, write,
 * or delete any file. Does NOT re-ingest anything (no PendingTicket/Ticket/
 * TicketMessage/Attachment row is ever created). This is purely a
 * classification report, read-only end to end — modeled on the existing
 * single-record recovery tool (scripts/repair-flattened-table-layout-body.ts),
 * reusing its exact mailbox-resolution and message-verification logic, but
 * scanning every row instead of one named record.
 *
 * CORRELATION MECHANISM — identity verified BEFORE any attachment is ever
 * matched, never the other way around:
 *   1. TicketAttachment/PendingTicketAttachment row -> owning
 *      Ticket/TicketMessage/PendingTicket's own emailMessageId (Graph's
 *      RFC 5322 internetMessageId — stable across folder moves within a
 *      mailbox, NOT Graph's own mutable message `id`). No emailMessageId
 *      at all -> "no_email_correlation", stop here.
 *   2. EmailProcessingLog row(s) matching that messageId -> exactly one
 *      distinct `mailbox`. Zero, or more than one distinct mailbox, is
 *      NEVER resolved to a default/guessed value -> "mailbox_unresolved",
 *      stop here. (Multi-mailbox inbound polling means the mailbox
 *      genuinely varies per message — there is no single fixed mailbox to
 *      fall back to.)
 *   3. ONE microsoftGraph.getMessageByInternetMessageId(mailbox,
 *      emailMessageId) call per DISTINCT (mailbox, emailMessageId) pair —
 *      searches the whole mailbox (not folder-scoped), read-only, never
 *      marks read or moves the message. Every attachment that resolved to
 *      the SAME source message shares this one call (see "Graph request
 *      budget" below) rather than each triggering its own lookup.
 *   4. A THROWN error from the Graph call (authentication, authorization,
 *      throttling, network, or server error) -> "graph_request_failed" —
 *      this means the request did not succeed, so whether the message
 *      exists is UNKNOWN; it is never treated as evidence the message was
 *      deleted. A SUCCESSFUL request that returned zero matches, or a
 *      mismatched internetMessageId (defense against a wrong message),
 *      means the message genuinely isn't there -> "graph_message_not_found"
 *      — this distinction is load-bearing: getMessageByInternetMessageId
 *      only ever represents "not found" via a clean `null` return from a
 *      successful request, never via a thrown exception, so the two cases
 *      can never be conflated by construction, not just by convention.
 *   5. ONLY NOW, with the source email's identity verified, is the row
 *      matched within that message's own attachments by originalName +
 *      size (neither TicketAttachment nor PendingTicketAttachment stores
 *      the Graph attachment's own `id` — this is the best available
 *      correlation key). Exactly one match with contentBytes present ->
 *      "graph_recoverable". Zero matches, or more than one (ambiguous) ->
 *      "graph_attachment_ambiguous_or_missing" — never guessed.
 *
 * GRAPH REQUEST BUDGET
 *   --limit=<n> (default 50) caps the number of DISTINCT
 *   getMessageByInternetMessageId calls this run makes — NOT the number of
 *   rows, since several attachments routinely share one source email and
 *   must only trigger one lookup for all of them (requirement: avoid
 *   unnecessary repeated lookups for attachments belonging to the same
 *   message). Rows whose message lookup would exceed the limit are
 *   reported separately as "not checked this run (limit reached)," never
 *   silently dropped — re-run with a higher --limit to cover them.
 *
 * OUTPUT — safe diagnostic identifiers only: attachment row id, owning
 * ticketId/pendingTicketId, mimeType, the resolved mailbox ADDRESS, and
 * (on a recoverable match) the Graph attachment's own id. NEVER prints
 * attachment bytes/contents, a Graph access token, or any email body/
 * subject/preview text — this script never even requests those fields.
 *
 * SAFETY
 *   - Entirely read-only: only SELECT queries and Graph GET calls.
 *   - No Graph call is made at all unless at least one row actually needs
 *     one (no throwaway/probe connectivity call) — if GRAPH_TENANT_ID/
 *     GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET aren't configured, the FIRST real
 *     lookup throws GraphConfigurationError, which is caught, reported
 *     plainly, and aborts the run (never silently misclassifies rows that
 *     were never actually checked).
 *   - Never invoked automatically — purely an operator-run diagnostic.
 *
 * Usage:
 *   npx tsx scripts/diagnose-attachment-graph-recovery.ts
 *   npx tsx scripts/diagnose-attachment-graph-recovery.ts --limit=200
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR } from "@/lib/attachment-policy";
import { microsoftGraph, GraphConfigurationError } from "@/lib/microsoft-graph";

type Classification =
  | "file_present"
  | "graph_recoverable"
  | "graph_attachment_ambiguous_or_missing"
  | "graph_message_not_found"
  | "graph_request_failed"
  | "mailbox_unresolved"
  | "no_email_correlation";

/**
 * Distinguishes WHY a Graph request didn't succeed — authentication,
 * authorization, throttling, and network/server errors are all genuine
 * REQUEST failures (we learned nothing about whether the message exists)
 * and must never be reported as "message not found"/"deleted." Only a
 * request that actually SUCCEEDED (HTTP 2xx) with zero matching messages
 * means the message is genuinely gone — see getMessageByInternetMessageId
 * in lib/microsoft-graph.ts, which represents that case by returning
 * `null`, never by throwing. Every thrown error reaching this function is
 * therefore, by construction, a request-level failure, not a "not found."
 * Parses lib/microsoft-graph.ts's own plain Error message text (its
 * `graphRequest`/`getAccessToken` helpers throw `Error`, not a typed
 * subclass, so this is necessarily text-based) — never includes the
 * Authorization header or token value, which graphRequest's own error
 * construction already excludes.
 */
function classifyGraphFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Failed to get access token/.test(msg)) return "authentication failure (could not obtain a Graph access token — check GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET)";
  const statusMatch = msg.match(/Graph API error (\d+)/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401) return "authentication failure (401 Unauthorized)";
    if (status === 403) return "authorization failure (403 Forbidden — insufficient Graph API permissions for this mailbox)";
    if (status === 429) return "throttled (429 Too Many Requests — Graph rate limit hit)";
    if (status >= 500) return `Graph server error (${status})`;
    return `Graph API error ${status}`;
  }
  return "network or unknown error (no HTTP status could be parsed from the failure)";
}

type Row = {
  kind: "ticket" | "pending";
  id: string;
  ownerId: string; // ticketId or pendingTicketId
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function storagePaths(row: Row): { privatePath: string; legacyPath: string } {
  if (row.kind === "ticket") {
    return {
      privatePath: path.join(UPLOAD_DIR, row.ownerId, row.filename),
      legacyPath: path.join(LEGACY_PUBLIC_UPLOAD_DIR, row.ownerId, row.filename),
    };
  }
  return {
    privatePath: path.join(UPLOAD_DIR, "pending", row.ownerId, row.filename),
    legacyPath: path.join(LEGACY_PUBLIC_UPLOAD_DIR, "pending", row.ownerId, row.filename),
  };
}

/** Exactly one distinct mailbox for this messageId, or "unresolved" — never guesses among several, never falls back to a default mailbox. */
async function resolveMailbox(emailMessageId: string): Promise<{ ok: true; mailbox: string } | { ok: false }> {
  const logs = await prisma.emailProcessingLog.findMany({
    where: { messageId: emailMessageId, mailbox: { not: null } },
    select: { mailbox: true },
  });
  const distinct = [...new Set(logs.map((l) => l.mailbox!))];
  if (distinct.length !== 1) return { ok: false };
  return { ok: true, mailbox: distinct[0] };
}

/** The emailMessageId the owning entity was ingested from, or null. For a ticket-level TicketAttachment (messageId: null) this is the Ticket's own emailMessageId (the original creating email); for a reply attachment it's that specific TicketMessage's own emailMessageId (a later email in the same thread). */
async function resolveEmailMessageId(row: Row): Promise<string | null> {
  if (row.kind === "pending") {
    const pending = await prisma.pendingTicket.findUnique({ where: { id: row.ownerId }, select: { emailMessageId: true } });
    return pending?.emailMessageId ?? null;
  }
  const attachment = await prisma.ticketAttachment.findUnique({
    where: { id: row.id },
    select: { messageId: true, ticket: { select: { emailMessageId: true } } },
  });
  if (!attachment) return null;
  if (attachment.messageId) {
    const msg = await prisma.ticketMessage.findUnique({ where: { id: attachment.messageId }, select: { emailMessageId: true } });
    if (msg?.emailMessageId) return msg.emailMessageId;
  }
  return attachment.ticket.emailMessageId ?? null;
}

async function main() {
  const limitArg = process.argv.slice(2).find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 50;

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  console.log(`UPLOAD_DIR:                      ${path.resolve(UPLOAD_DIR)}`);
  console.log(`LEGACY_PUBLIC_UPLOAD_DIR:        ${path.resolve(LEGACY_PUBLIC_UPLOAD_DIR)}`);
  console.log(`Graph request budget (--limit):  ${limit} distinct message lookups\n`);

  const ticketAttachments = await prisma.ticketAttachment.findMany({
    select: { id: true, ticketId: true, filename: true, originalName: true, mimeType: true, size: true },
  });
  const pendingAttachments = await prisma.pendingTicketAttachment.findMany({
    select: { id: true, pendingTicketId: true, filename: true, originalName: true, mimeType: true, size: true },
  });

  const allRows: Row[] = [
    ...ticketAttachments.map((a) => ({ kind: "ticket" as const, id: a.id, ownerId: a.ticketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size })),
    ...pendingAttachments.map((a) => ({ kind: "pending" as const, id: a.id, ownerId: a.pendingTicketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size })),
  ];
  console.log(`Total attachment rows: ${allRows.length}\n`);

  const results = new Map<string, { classification: Classification; detail: string }>();
  const rowKey = (r: Row) => `${r.kind}:${r.id}`;

  // ── Pass 1: local storage presence — no Graph involved at all. ──
  const needsGraphCheck: Row[] = [];
  for (const row of allRows) {
    const { privatePath, legacyPath } = storagePaths(row);
    if ((await exists(privatePath)) || (await exists(legacyPath))) {
      results.set(rowKey(row), { classification: "file_present", detail: "Bytes found in local storage." });
    } else {
      needsGraphCheck.push(row);
    }
  }

  // ── Pass 2: resolve emailMessageId + mailbox per missing row — still no
  //    Graph calls, pure DB reads — then group by the EXACT (mailbox,
  //    emailMessageId) pair so every attachment sharing one source email
  //    triggers exactly one Graph lookup, never one per attachment. ──
  const messageGroups = new Map<string, { mailbox: string; emailMessageId: string; rows: Row[] }>();
  for (const row of needsGraphCheck) {
    const emailMessageId = await resolveEmailMessageId(row);
    if (!emailMessageId) {
      results.set(rowKey(row), { classification: "no_email_correlation", detail: "No emailMessageId on the owning record — not an email-ingested attachment, or source metadata was never recorded." });
      continue;
    }
    const mailboxResult = await resolveMailbox(emailMessageId);
    if (!mailboxResult.ok) {
      results.set(rowKey(row), { classification: "mailbox_unresolved", detail: `EmailProcessingLog has zero, or more than one distinct, mailbox recorded for messageId ${emailMessageId}.` });
      continue;
    }
    const key = `${mailboxResult.mailbox}::${emailMessageId}`;
    if (!messageGroups.has(key)) messageGroups.set(key, { mailbox: mailboxResult.mailbox, emailMessageId, rows: [] });
    messageGroups.get(key)!.rows.push(row);
  }

  // ── Pass 3: ONE Graph lookup per distinct message group, bounded by
  //    --limit. Attachment matching only ever happens AFTER the message's
  //    own identity has been verified, never before. ──
  let graphRequestsMade = 0;
  let notCheckedLimitReached = 0;
  for (const { mailbox, emailMessageId, rows } of messageGroups.values()) {
    if (graphRequestsMade >= limit) {
      notCheckedLimitReached += rows.length;
      continue;
    }
    graphRequestsMade++;

    let message;
    try {
      message = await microsoftGraph.getMessageByInternetMessageId(mailbox, emailMessageId);
    } catch (err) {
      if (err instanceof GraphConfigurationError) {
        console.log(`\nMicrosoft Graph is not configured in this environment — aborting. (${err.message})`);
        await prisma.$disconnect();
        process.exit(1);
      }
      // A thrown error here is ALWAYS a request-level failure (auth,
      // authorization, throttling, network, server error) — NEVER evidence
      // the message doesn't exist. getMessageByInternetMessageId only ever
      // represents "genuinely not found" by returning null from a
      // SUCCESSFUL request (see the branch below), so this catch block
      // must never be classified the same way as that one.
      const detail = `Request failed, message existence unknown: ${classifyGraphFailure(err)}.`;
      for (const row of rows) results.set(rowKey(row), { classification: "graph_request_failed", detail });
      continue;
    }

    if (!message) {
      const detail = `Graph request succeeded with zero matches for this internetMessageId in mailbox ${mailbox} (deleted or purged).`;
      for (const row of rows) results.set(rowKey(row), { classification: "graph_message_not_found", detail });
      continue;
    }
    if (message.internetMessageId !== emailMessageId) {
      const detail = "Graph returned a mismatched internetMessageId — refusing to trust it.";
      for (const row of rows) results.set(rowKey(row), { classification: "graph_message_not_found", detail });
      continue;
    }

    // Identity verified above — only now is any attachment ever matched.
    for (const row of rows) {
      const candidates = (message.attachments ?? []).filter((a) => a.name === row.originalName && a.size === row.size && !!a.contentBytes);
      if (candidates.length === 1) {
        results.set(rowKey(row), { classification: "graph_recoverable", detail: `Mailbox ${mailbox}, Graph attachment id ${candidates[0].id}.` });
      } else if (candidates.length === 0) {
        results.set(rowKey(row), { classification: "graph_attachment_ambiguous_or_missing", detail: `Message found (mailbox ${mailbox}) but no attachment on it matches name/size.` });
      } else {
        results.set(rowKey(row), { classification: "graph_attachment_ambiguous_or_missing", detail: `Message found (mailbox ${mailbox}) but ${candidates.length} attachments match name/size — cannot safely pick one.` });
      }
    }
  }

  // ── Report — safe diagnostic identifiers only. ──
  const counts: Record<Classification, number> = {
    file_present: 0,
    graph_recoverable: 0,
    graph_attachment_ambiguous_or_missing: 0,
    graph_message_not_found: 0,
    graph_request_failed: 0,
    mailbox_unresolved: 0,
    no_email_correlation: 0,
  };
  for (const row of allRows) {
    const result = results.get(rowKey(row));
    if (!result) continue; // skipped this run due to --limit
    counts[result.classification]++;
    if (result.classification !== "file_present") {
      console.log(`  [${result.classification}] ${row.kind} ${row.id} (${row.kind === "ticket" ? "ticketId" : "pendingTicketId"}=${row.ownerId}, mimeType=${row.mimeType}) — ${result.detail}`);
    }
  }

  console.log(`\nGraph requests made this run:        ${graphRequestsMade} (of --limit=${limit})`);
  console.log(`Rows not checked (limit reached):    ${notCheckedLimitReached}`);
  console.log("\n=== Summary ===");
  for (const [bucket, count] of Object.entries(counts)) {
    console.log(`${bucket.padEnd(38)} ${count}`);
  }
  console.log("\nThis script wrote nothing — no DB rows changed, no files written, no emails modified or re-ingested.");
  await prisma.$disconnect();
}

main();
