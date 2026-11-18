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
 *      matched within that message's own attachments — in several
 *      SEPARATE, ordered steps, deliberately never collapsed into one
 *      filter (collapsing them was a real bug, fixed in an earlier round
 *      — see METADATA VS. BYTE AVAILABILITY below; a second real-world run
 *      then showed EVERY one of 10 affected rows landing in the SAME
 *      "zero metadata matches" bucket even after that split, across only
 *      3 distinct messages — too uniform to be 10 independent name/size
 *      coincidences, and the actual, most likely explanation per
 *      Microsoft's own forums is that `$expand=attachments` combined with
 *      `$filter=...` on the LIST endpoint this app uses
 *      (`/messages?$filter=...&$expand=attachments`) can silently return
 *      no attachments collection at all, even when the SAME message's
 *      `hasAttachments` is true and a direct `/messages/{id}?$expand=
 *      attachments` GET would have worked — see ATTACHMENT COLLECTION
 *      PRESENCE below, the fix for THIS round):
 *        a. COLLECTION PRESENCE — is `message.attachments` even an array,
 *           and non-empty? See ATTACHMENT COLLECTION PRESENCE below.
 *        b. NAME match — does ANY attachment on the message share this
 *           row's originalName, regardless of size?
 *        c. SIZE match (among same-name candidates) — does exactly one of
 *           those also match this row's size?
 *        d. Only once EXACTLY ONE metadata match (name AND size) is found
 *           is its byte availability checked: usable `contentBytes` ->
 *           "graph_recoverable". Not usable -> classified further by
 *           @odata.type (see METADATA VS. BYTE AVAILABILITY below).
 *
 * ATTACHMENT COLLECTION PRESENCE — added this round, in response to a
 * second real production run: after splitting metadata-matching from
 * byte-availability (previous fix), EVERY ONE of 10 affected rows still
 * showed zero metadata matches, across only 3 distinct successfully-found
 * messages. That's not plausibly 10 independent name/size mismatches; it's
 * far more consistent with `message.attachments` itself coming back
 * empty/absent for those messages. This diagnostic now distinguishes that
 * directly, BEFORE ever attempting a name/size match, instead of silently
 * treating "no attachments array" and "attachments present but none
 * match" as the same thing (`(message.attachments ?? []).filter(...)` in
 * the previous version did exactly that, by construction):
 *   - "graph_no_attachment_collection" — `message.attachments` is
 *     `undefined` (the field wasn't in the response at all).
 *   - "graph_empty_attachment_collection" — `message.attachments` is a
 *     present-but-empty array. Both report `message.hasAttachments`
 *     alongside (a cheap, already-selected boolean) — "collection empty
 *     AND hasAttachments: true" is strong, direct evidence of the
 *     suspected $expand-on-filtered-list Graph quirk, never printed as a
 *     filename/content, just a boolean + a count.
 * NOT fixed this round (deliberately out of scope — see "what this round
 * does NOT do" below): if this diagnosis is confirmed, the correct next
 * step is a dedicated fallback `GET /users/{mailbox}/messages/{id}/
 * attachments` (the documented, reliable "list attachments" endpoint, by
 * message id — not the filtered list query) when the first response's
 * collection is empty/absent despite hasAttachments being true. That is a
 * genuinely NEW Graph request shape and is intentionally not implemented
 * or run here, pending this diagnostic's own (still budget-limited,
 * still-approval-gated) confirmation that it's actually needed.
 *
 * NAME VS. SIZE MISMATCH — once a non-empty attachment collection exists,
 * matching is now two explicit sub-steps instead of one combined filter,
 * so a genuine name-only or size-only mismatch is distinguishable from
 * true ambiguity:
 *   - "graph_attachment_name_mismatch" — no attachment on the message
 *     shares this row's originalName at all.
 *   - "graph_attachment_size_mismatch" — one or more attachments share the
 *     name, but none also match the row's recorded size (ingestion-side
 *     size is `Buffer.from(contentBytes, "base64").length` — the decoded
 *     byte count, the same unit Graph's own `size` property uses; traced
 *     in lib/services/pending-ticket-service.ts and
 *     lib/ticket-email-service.ts, no transformation or unit conversion
 *     found at either ingestion site).
 *   - "graph_attachment_ambiguous" — 2+ attachments match BOTH name and
 *     size — genuinely ambiguous, never guessed.
 *
 * METADATA VS. BYTE AVAILABILITY — Microsoft Graph only ever populates
 * `contentBytes` on a `#microsoft.graph.fileAttachment`; `itemAttachment`
 * (a forwarded email/contact/event/.msg) and `referenceAttachment` (a
 * OneDrive/SharePoint link) NEVER have it, regardless of $select/$expand —
 * this is documented Graph behavior, not a bug in this app's query. The
 * PREVIOUS version of this script filtered on
 * `name === X && size === Y && !!contentBytes` as a SINGLE condition,
 * which meant a genuine, unique metadata match with merely-absent
 * contentBytes was indistinguishable from "no attachment matches at all"
 * — exactly what explained a real production run reporting 0
 * graph_recoverable despite the source emails being found successfully.
 * Fixed by splitting the two checks:
 *   - "graph_recoverable" — unique metadata match, contentBytes present.
 *   - "graph_metadata_matched_not_file_type" — unique metadata match,
 *     but @odata.type isn't fileAttachment (itemAttachment/
 *     referenceAttachment) — bytes are structurally unavailable this way,
 *     not merely missing from this one response.
 *   - "graph_metadata_matched_bytes_unavailable" — unique metadata match,
 *     IS a fileAttachment, but contentBytes wasn't present in this
 *     response anyway — the Graph attachment's own `id` is still known
 *     (printed), so a targeted follow-up `GET .../attachments/{id}` (or
 *     `/$value`) could retrieve it — NOT performed by this script, which
 *     never makes more than the one budgeted lookup per message.
 *   - "graph_attachment_ambiguous_or_missing" — zero or 2+ metadata
 *     matches — unchanged from before.
 *
 * `contentBytes` PRESENCE IS NOT ENOUGH — "graph_recoverable" additionally
 * requires the base64 to actually decode AND the decoded byte length to
 * exactly equal the row's own recorded `size`. A present-but-truncated,
 * corrupted, or otherwise-mismatched value is real-world possible (a
 * malformed response, a proxy/gateway altering the body, etc.) and must
 * never be silently trusted as "recoverable" just because the field was
 * non-empty — see isUsableContentBytes below. A row that fails this check
 * falls through to the same classification its absent-bytes counterpart
 * would get (graph_metadata_matched_bytes_unavailable /
 * graph_metadata_matched_not_file_type), with a detail string that says
 * WHICH case it was (absent vs. present-but-invalid) — never reported as
 * recoverable either way.
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
  | "graph_metadata_matched_bytes_unavailable"
  | "graph_metadata_matched_not_file_type"
  | "graph_no_attachment_collection"
  | "graph_empty_attachment_collection"
  | "graph_attachment_name_mismatch"
  | "graph_attachment_size_mismatch"
  | "graph_attachment_ambiguous"
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

/**
 * True only if `contentBytes` is REAL, decodable, correctly-sized file
 * content — never just "the field was present." A present-but-empty,
 * malformed (not valid base64), or wrong-length value is NOT trusted as
 * recoverable; `expectedSize` is the row's own recorded size (already
 * confirmed equal to Graph's reported attachment size by the metadata
 * match this is only ever called after), so the decoded byte length must
 * match it exactly — a mismatch means the bytes we got don't actually
 * correspond to this file, whatever the reason.
 */
function isUsableContentBytes(contentBytes: string | undefined, expectedSize: number): boolean {
  if (!contentBytes || contentBytes.trim().length === 0) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(contentBytes, "base64");
  } catch {
    return false;
  }
  return decoded.length > 0 && decoded.length === expectedSize;
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

    // Identity verified above — only now is any attachment ever matched,
    // and in several SEPARATE, ordered steps, never one combined filter —
    // see ATTACHMENT COLLECTION PRESENCE and NAME VS. SIZE MISMATCH above
    // for why each of these is kept distinct rather than folded into the
    // next one's catch-all.
    for (const row of rows) {
      // Step a — is there even an attachments collection to look in? This
      // MUST run before any name/size filtering, because
      // `(message.attachments ?? []).filter(...)` would otherwise silently
      // treat "Graph returned no collection at all" the same as "returned
      // a collection with no matching entry" — exactly the ambiguity a
      // real production run showed was hiding the actual cause.
      if (message.attachments === undefined) {
        results.set(rowKey(row), {
          classification: "graph_no_attachment_collection",
          detail: `Message found (mailbox ${mailbox}) but the response had no "attachments" field at all (message.hasAttachments=${message.hasAttachments}).`,
        });
        continue;
      }
      if (message.attachments.length === 0) {
        results.set(rowKey(row), {
          classification: "graph_empty_attachment_collection",
          detail: `Message found (mailbox ${mailbox}) with an empty attachments array (message.hasAttachments=${message.hasAttachments}).`,
        });
        continue;
      }

      // Step b — name match, independent of size, so a pure size mismatch
      // is never reported as if the name didn't match either.
      const nameMatches = message.attachments.filter((a) => a.name === row.originalName);
      if (nameMatches.length === 0) {
        results.set(rowKey(row), {
          classification: "graph_attachment_name_mismatch",
          detail: `Message found (mailbox ${mailbox}, ${message.attachments.length} attachment(s) on it) but none share this row's originalName.`,
        });
        continue;
      }

      // Step c — size match, only among the same-name candidates.
      const metadataMatches = nameMatches.filter((a) => a.size === row.size);
      if (metadataMatches.length === 0) {
        results.set(rowKey(row), {
          classification: "graph_attachment_size_mismatch",
          detail: `Message found (mailbox ${mailbox}); ${nameMatches.length} attachment(s) share this row's originalName but none also match its size.`,
        });
        continue;
      }
      if (metadataMatches.length > 1) {
        results.set(rowKey(row), { classification: "graph_attachment_ambiguous", detail: `Message found (mailbox ${mailbox}) but ${metadataMatches.length} attachments match BOTH name and size — cannot safely pick one.` });
        continue;
      }

      const match = metadataMatches[0];
      const bytesUsable = isUsableContentBytes(match.contentBytes, row.size);
      if (bytesUsable) {
        results.set(rowKey(row), { classification: "graph_recoverable", detail: `Mailbox ${mailbox}, Graph attachment id ${match.id}.` });
        continue;
      }

      // Unique metadata match, but the bytes aren't usable — either absent
      // from this response, or present but failed decode/length validation
      // (isUsableContentBytes). @odata.type isn't part of the shared
      // GraphAttachment type in lib/microsoft-graph.ts (reading it here is
      // diagnostic-only — this never touches that module or any
      // application ingestion behavior) — it tells us WHY: a
      // non-fileAttachment structurally never carries contentBytes via
      // this API at all, vs. a genuine fileAttachment that just needs a
      // targeted follow-up GET (or whose bytes in this response were
      // corrupt/truncated).
      const bytesReason = !match.contentBytes
        ? "contentBytes was absent from this response"
        : "contentBytes was present but failed validation (did not decode to the expected byte length) — not trusted";
      const odataType = (match as { ["@odata.type"]?: string })["@odata.type"];
      if (odataType && !odataType.toLowerCase().includes("fileattachment")) {
        results.set(rowKey(row), {
          classification: "graph_metadata_matched_not_file_type",
          detail: `Mailbox ${mailbox}, Graph attachment id ${match.id}, type ${odataType} — not a fileAttachment, so Graph never provides raw bytes for it via this API.`,
        });
      } else {
        results.set(rowKey(row), {
          classification: "graph_metadata_matched_bytes_unavailable",
          detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — unique name/size match, appears to be a fileAttachment, but ${bytesReason}. A targeted follow-up GET on this specific attachment id would be the next step — not performed by this script.`,
        });
      }
    }
  }

  // ── Report — safe diagnostic identifiers only. ──
  const counts: Record<Classification, number> = {
    file_present: 0,
    graph_recoverable: 0,
    graph_metadata_matched_bytes_unavailable: 0,
    graph_metadata_matched_not_file_type: 0,
    graph_no_attachment_collection: 0,
    graph_empty_attachment_collection: 0,
    graph_attachment_name_mismatch: 0,
    graph_attachment_size_mismatch: 0,
    graph_attachment_ambiguous: 0,
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
