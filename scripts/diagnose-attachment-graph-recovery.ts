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
 *        b. NAME match — does EXACTLY ONE attachment on the message share
 *           this row's originalName? This is now the SOLE uniqueness gate
 *           (zero -> name mismatch, 2+ -> ambiguous) — see GRAPH METADATA
 *           SIZE RELIABILITY below for why size is never used to pick among
 *           same-named candidates.
 *        c. Does that one match's Graph-reported `size` equal the row's DB
 *           size? If so, proceed straight to byte availability (step d)
 *           against that size. If not — a genuine, confirmed-in-production
 *           case — Graph's `size` metadata is treated as unreliable, NOT as
 *           proof the attachment is wrong, and the decoded contentBytes is
 *           compared against the row's DB size instead (see GRAPH METADATA
 *           SIZE RELIABILITY below).
 *        d. Byte availability: usable `contentBytes` (decodes to exactly
 *           the expected size) -> recoverable. Not usable -> classified
 *           further (see METADATA VS. BYTE AVAILABILITY below).
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
 * name is checked first, independent of size:
 *   - "graph_attachment_name_mismatch" — no attachment on the message
 *     shares this row's originalName at all.
 *   - "graph_attachment_ambiguous" — 2+ attachments share the name — no
 *     second signal (Graph's `size` is explicitly NOT trusted to
 *     disambiguate — see GRAPH METADATA SIZE RELIABILITY below) can safely
 *     pick one, so this is never guessed.
 * Exactly one name match proceeds to GRAPH METADATA SIZE RELIABILITY below.
 *
 * GRAPH METADATA SIZE RELIABILITY — added this round, in response to a
 * THIRD real production run. After the previous two fixes (byte/metadata
 * split, then collection-presence split), a run against 206 real
 * attachment rows found exactly 10 that matched by originalName with a
 * single unique candidate each (3 distinct successfully-found messages,
 * no missing collections, no name mismatches, no Graph request errors) —
 * and EVERY one of those 10 failed solely because the Graph attachment's
 * reported `size` differed from this row's own DB-recorded `size`.
 *
 * Ingestion-side size (lib/services/pending-ticket-service.ts,
 * lib/ticket-email-service.ts, re-traced this round) is
 * `Buffer.from(att.contentBytes, "base64").length` — the DECODED byte
 * count of the SAME Graph attachment at the time it was first ingested,
 * not a copy of Graph's `size` field. So "DB size" and "Graph's `size`
 * property" were never guaranteed to be the same number in the first
 * place, even though they usually agree: Microsoft's own fileAttachment
 * reference (learn.microsoft.com/graph/api/resources/fileattachment)
 * documents `size` only as "the size in bytes of the attachment," with NO
 * stated guarantee that it equals `Buffer.from(contentBytes,
 * "base64").length`. Third-party evidence of exactly this gap exists: a
 * documented case (microsoft-graph-docs-contrib community report) showed
 * Graph returning a list-metadata size of 42,710 bytes for an attachment
 * whose decoded content was actually 42,326 bytes — attributed to `size`
 * sometimes reflecting a different internal accounting (e.g. Outlook's
 * MAPI-level PR_ATTACH_SIZE) than the literal decoded payload length. The
 * conclusion: Graph's `size` is provider metadata, not a byte-for-byte
 * guarantee — the ONLY way to know the true content length is to decode
 * `contentBytes` and measure it directly.
 *
 * Consequently, a metadata size mismatch is NEVER treated as proof the
 * attachment is wrong, and (per explicit requirement) NEVER treated as
 * recoverable on name alone either — it triggers a direct comparison of
 * decoded contentBytes length against the row's OWN DB size (never
 * against Graph's possibly-wrong `size` field), yielding four distinct
 * outcomes:
 *   - "graph_recoverable_metadata_size_mismatch" — Graph's `size` disagreed
 *     with the DB, but the decoded `contentBytes` length matches the DB
 *     size exactly. This marks it a RECOVERY CANDIDATE, never proof of
 *     byte-for-byte identity with the original historical content — this
 *     diagnostic has no hash or other content signature to verify that,
 *     only a length match; Graph's size metadata simply shouldn't be
 *     trusted as the deciding signal. This is the only mismatch outcome
 *     that is actually a recovery candidate, and only because bytes were
 *     independently checked — never because the name matched alone.
 *   - "graph_metadata_size_mismatch_bytes_differ" — contentBytes decodes
 *     successfully (well-formed base64) but to a length that matches
 *     NEITHER the DB size NOR Graph's reported size — genuinely different
 *     content, not recoverable from this response.
 *   - "graph_metadata_size_mismatch_bytes_unavailable" — contentBytes was
 *     absent (the field was missing from the response entirely), so the
 *     size disagreement can't be resolved at all this run.
 *   - "graph_metadata_size_mismatch_malformed_base64" — contentBytes was
 *     present but is NOT well-formed base64 (see STRICT BASE64 VALIDATION
 *     below) — not trusted either way.
 *
 * STRICT BASE64 VALIDATION & ZERO-BYTE ATTACHMENTS — two correctness fixes
 * made this round, both in checkContentBytes:
 *   1. `Buffer.from(str, "base64")` is deliberately LENIENT: it silently
 *      drops any character outside the base64 alphabet rather than
 *      rejecting malformed input, so a corrupted or truncated value could
 *      previously decode into a plausible-looking (but wrong) byte
 *      sequence without ever being flagged as malformed — just an opaque
 *      length mismatch. This now validates the string against a strict
 *      base64 pattern (correct alphabet, correct padding, length a
 *      multiple of 4) BEFORE ever decoding it, so malformed input gets
 *      its own classification ("graph_metadata_size_mismatch_malformed_
 *      base64" / the equivalent reason text in the straightforward path)
 *      instead of silently decoding into a confusing wrong-length result.
 *   2. A legitimately EMPTY attachment (DB-recorded size 0) is correctly
 *      base64-encoded as the empty string `""` — that's valid, zero-length
 *      content, not "absent." The previous check
 *      (`decoded.length > 0 && decoded.length === expectedSize`) would
 *      have wrongly rejected this exact case, since 0 > 0 is false — a
 *      real 0-byte file could never be classified recoverable. Only a
 *      MISSING field (contentBytes is `undefined`/`null` — not in the
 *      response at all) is "absent" now; an explicit `""` is evaluated on
 *      its own merits like any other value and correctly comes back
 *      "usable" when the expected size is also 0.
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
 * requires the base64 to be well-formed (see STRICT BASE64 VALIDATION
 * above) AND the decoded byte length to exactly equal the row's own
 * recorded `size` — and even then it is reported as a RECOVERY CANDIDATE,
 * not proof of byte-for-byte identity with history (see GRAPH METADATA
 * SIZE RELIABILITY above — the same caveat applies here, not just to the
 * metadata-mismatch case). A present-but-truncated, corrupted, malformed,
 * or otherwise-mismatched value is real-world possible (a malformed
 * response, a proxy/gateway altering the body, etc.) and must never be
 * silently trusted as a recovery candidate just because the field was
 * non-empty — see checkContentBytes below. A row that fails this check
 * falls through to the same classification its absent-bytes counterpart
 * would get (graph_metadata_matched_bytes_unavailable /
 * graph_metadata_matched_not_file_type), with a detail string that says
 * WHICH case it was (absent vs. malformed vs. present-but-wrong-length) —
 * never reported as a recovery candidate either way.
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
 * DRY RUN & BUDGET CONFIRMATION — added this round. A FOURTH real
 * production run hit its --limit before classifying every row, leaving
 * some rows "not checked (limit reached)." Since every run re-derives
 * `messageGroups` from scratch (there is no cross-run memory of which
 * messages were already looked up), guessing a larger --limit for the
 * next run would itself be a guess — exactly what this script's own
 * matching rules refuse to do for attachment identity, so the budget
 * shouldn't be guessed either. `--dry-run` runs Passes 1-2 (purely local:
 * file-presence checks and DB reads for emailMessageId/mailbox
 * resolution) and stops BEFORE Pass 3 — the only part of this script that
 * ever calls microsoftGraph — making this flag's own Graph request count
 * always exactly zero. It reports the EXACT number of distinct
 * (mailbox, emailMessageId) groups required to classify every currently-
 * unresolved row, which is the precise --limit value needed for a single
 * complete pass. Run `--dry-run` first, read off that number, then run
 * for real with `--limit=<that number>` (or slightly higher, to allow for
 * new tickets/replies ingested between the two runs).
 *
 * DISTINCT GRAPH ATTACHMENT ID COUNTS — added this round. The summary now
 * reports, for every classification that resolved a specific Graph
 * attachment id, how many DISTINCT source attachments are behind that
 * bucket's row count — not just the row count itself. Several different
 * attachment ROWS (e.g. the same file attached to a ticket and later
 * re-sent in a reply, or a duplicate ingestion) can resolve to the SAME
 * underlying Graph attachment; a plain row count alone hides that. The
 * dedup key is `${mailbox}::${emailMessageId}::${match.id}`, NEVER the
 * bare Graph attachment id alone — Graph only documents attachment ids as
 * unique WITHIN the message/mailbox they came from, never guaranteed
 * unique ACROSS different mailboxes, so deduping on the bare id could
 * theoretically undercount if two different mailboxes ever produced the
 * same id string. The composite key rules that out by construction. Both
 * the printed id and the dedup key are safe diagnostic identifiers
 * (Graph's own opaque attachment id plus the already-resolved mailbox
 * address), never filenames or content.
 *
 * Usage:
 *   npx tsx scripts/diagnose-attachment-graph-recovery.ts --dry-run
 *   npx tsx scripts/diagnose-attachment-graph-recovery.ts
 *   npx tsx scripts/diagnose-attachment-graph-recovery.ts --limit=200
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR } from "@/lib/attachment-policy";
import { microsoftGraph, GraphConfigurationError } from "@/lib/microsoft-graph";
import { checkContentBytes } from "@/scripts/attachment-graph-recovery-base64";

type Classification =
  | "file_present"
  | "graph_recoverable"
  | "graph_metadata_matched_bytes_unavailable"
  | "graph_metadata_matched_not_file_type"
  | "graph_no_attachment_collection"
  | "graph_empty_attachment_collection"
  | "graph_attachment_name_mismatch"
  | "graph_recoverable_metadata_size_mismatch"
  | "graph_metadata_size_mismatch_bytes_differ"
  | "graph_metadata_size_mismatch_bytes_unavailable"
  | "graph_metadata_size_mismatch_malformed_base64"
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

// checkContentBytes/isStrictlyValidBase64 live in their own side-effect-free
// module (scripts/attachment-graph-recovery-base64.ts) specifically so a
// focused test can exercise them directly — including multi-megabyte
// payloads — without importing this file (which would run its own `main()`
// as a side effect of import, same as it does for the other focused tests
// that intentionally trigger it against a mocked Graph client). See that
// module's own doc comments for the stack-overflow crash this fixed and why
// the fix is a manual scan rather than a regex.

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
  const argv = process.argv.slice(2);
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 50;
  const dryRun = argv.includes("--dry-run");

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

  // `graphAttachmentKey` is `${mailbox}::${emailMessageId}::${match.id}`, NOT
  // the bare Graph attachment id — Graph's own id is only documented to be
  // unique WITHIN the message/mailbox it came from, never guaranteed unique
  // across different mailboxes. Deduping on the bare id alone could
  // theoretically undercount distinct source attachments if two different
  // mailboxes ever produced the same id string; the composite key rules
  // that out entirely, by construction, regardless of how unlikely an
  // actual collision is in practice.
  const results = new Map<string, { classification: Classification; detail: string; graphAttachmentKey?: string }>();
  const rowKey = (r: Row) => `${r.kind}:${r.id}`;

  // ── Pass 1: local storage presence — no Graph involved at all. ──
  const needsGraphCheck: Row[] = [];
  let filePresentCount = 0;
  for (const row of allRows) {
    const { privatePath, legacyPath } = storagePaths(row);
    if ((await exists(privatePath)) || (await exists(legacyPath))) {
      results.set(rowKey(row), { classification: "file_present", detail: "Bytes found in local storage." });
      filePresentCount++;
    } else {
      needsGraphCheck.push(row);
    }
  }

  // ── Pass 2: resolve emailMessageId + mailbox per missing row — still no
  //    Graph calls, pure DB reads — then group by the EXACT (mailbox,
  //    emailMessageId) pair so every attachment sharing one source email
  //    triggers exactly one Graph lookup, never one per attachment. ──
  const messageGroups = new Map<string, { mailbox: string; emailMessageId: string; rows: Row[] }>();
  let noEmailCorrelationCount = 0;
  let mailboxUnresolvedCount = 0;
  for (const row of needsGraphCheck) {
    const emailMessageId = await resolveEmailMessageId(row);
    if (!emailMessageId) {
      results.set(rowKey(row), { classification: "no_email_correlation", detail: "No emailMessageId on the owning record — not an email-ingested attachment, or source metadata was never recorded." });
      noEmailCorrelationCount++;
      continue;
    }
    const mailboxResult = await resolveMailbox(emailMessageId);
    if (!mailboxResult.ok) {
      results.set(rowKey(row), { classification: "mailbox_unresolved", detail: `EmailProcessingLog has zero, or more than one distinct, mailbox recorded for messageId ${emailMessageId}.` });
      mailboxUnresolvedCount++;
      continue;
    }
    const key = `${mailboxResult.mailbox}::${emailMessageId}`;
    if (!messageGroups.has(key)) messageGroups.set(key, { mailbox: mailboxResult.mailbox, emailMessageId, rows: [] });
    messageGroups.get(key)!.rows.push(row);
  }

  // ── DRY RUN — stop here. Zero Graph requests made, by construction: this
  //    exits BEFORE Pass 3 (the only part of this script that ever calls
  //    microsoftGraph) even runs. Every run re-derives messageGroups from
  //    scratch (no cross-run cache of which messages were already looked
  //    up), so the distinct-group count reported here is the exact,
  //    CONFIRMED (not guessed/estimated) --limit needed for the NEXT real
  //    run to classify every currently-unresolved row in one pass. ──
  if (dryRun) {
    const rowsNeedingGraph = [...messageGroups.values()].reduce((sum, g) => sum + g.rows.length, 0);
    console.log("\n=== DRY RUN — no Microsoft Graph requests were made ===");
    console.log(`Already present locally (file_present):              ${filePresentCount}`);
    console.log(`No email correlation (not email-ingested):           ${noEmailCorrelationCount}`);
    console.log(`Mailbox unresolved (0 or 2+ distinct mailboxes):     ${mailboxUnresolvedCount}`);
    console.log(`Rows requiring a Graph lookup:                       ${rowsNeedingGraph}`);
    console.log(`Distinct (mailbox, emailMessageId) groups required: ${messageGroups.size}`);
    console.log(`\nRequired --limit for a complete single-pass run:   ${messageGroups.size}`);
    console.log("(Every run re-derives this grouping from scratch — there is no carry-over");
    console.log(" of previously-looked-up messages between runs — so --limit must cover ALL");
    console.log(" currently-unresolved rows' message groups, not just newly-added ones.)");
    await prisma.$disconnect();
    return;
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

      // Step b — name is now the SOLE uniqueness gate (never disambiguate
      // by size — see GRAPH METADATA SIZE RELIABILITY above for why Graph's
      // reported size can't be trusted to pick among same-named
      // candidates).
      const nameMatches = message.attachments.filter((a) => a.name === row.originalName);
      if (nameMatches.length === 0) {
        results.set(rowKey(row), {
          classification: "graph_attachment_name_mismatch",
          detail: `Message found (mailbox ${mailbox}, ${message.attachments.length} attachment(s) on it) but none share this row's originalName.`,
        });
        continue;
      }
      if (nameMatches.length > 1) {
        results.set(rowKey(row), { classification: "graph_attachment_ambiguous", detail: `Message found (mailbox ${mailbox}) but ${nameMatches.length} attachments share this row's originalName — Graph's size metadata is not a trustworthy disambiguator, so cannot safely pick one.` });
        continue;
      }

      const match = nameMatches[0];

      if (match.size === row.size) {
        // Straightforward case — Graph's own metadata size agrees with the
        // DB's recorded size. Byte availability is still independently
        // verified below — a matching size is never enough on its own, see
        // METADATA VS. BYTE AVAILABILITY above.
        const check = checkContentBytes(match.contentBytes, row.size);
        if (check.status === "usable") {
          results.set(rowKey(row), { classification: "graph_recoverable", detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — decoded contentBytes length matches the DB-recorded size; a recovery candidate (length equality is not proof of byte-for-byte identity with the original historical content).`, graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}` });
          continue;
        }
        const bytesReason = check.status === "absent"
          ? "contentBytes was absent from this response"
          : check.status === "malformed_base64"
          ? "contentBytes was present but was not well-formed base64 (malformed) — not trusted"
          : "contentBytes was present but decoded to a different length than expected — not trusted";
        const odataType = (match as { ["@odata.type"]?: string })["@odata.type"];
        if (odataType && !odataType.toLowerCase().includes("fileattachment")) {
          results.set(rowKey(row), {
            classification: "graph_metadata_matched_not_file_type",
            detail: `Mailbox ${mailbox}, Graph attachment id ${match.id}, type ${odataType} — not a fileAttachment, so Graph never provides raw bytes for it via this API.`,
            graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}`,
          });
        } else {
          results.set(rowKey(row), {
            classification: "graph_metadata_matched_bytes_unavailable",
            detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — unique name/size match, appears to be a fileAttachment, but ${bytesReason}. A targeted follow-up GET on this specific attachment id would be the next step — not performed by this script.`,
            graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}`,
          });
        }
        continue;
      }

      // match.size !== row.size — a GRAPH METADATA SIZE MISMATCH (see above).
      // This is NOT treated as a dead end, and NEVER treated as recoverable
      // on the name match alone: the only way to resolve it is to decode
      // contentBytes and compare it against the row's OWN DB size (never
      // against Graph's possibly-wrong `size` field).
      const sizeCheck = checkContentBytes(match.contentBytes, row.size);
      if (sizeCheck.status === "usable") {
        results.set(rowKey(row), {
          classification: "graph_recoverable_metadata_size_mismatch",
          detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — unique name match; Graph reported size ${match.size} but DB recorded size ${row.size}. Decoded contentBytes length is exactly ${row.size} — a recovery candidate despite the metadata disagreement (length equality is not proof of byte-for-byte identity with the original historical content); Graph's size metadata should not be trusted as the deciding signal here.`,
          graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}`,
        });
      } else if (sizeCheck.status === "absent") {
        results.set(rowKey(row), {
          classification: "graph_metadata_size_mismatch_bytes_unavailable",
          detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — unique name match; Graph reported size ${match.size} vs DB size ${row.size}, and contentBytes was absent from this response — cannot resolve which size (if either) reflects the real content.`,
          graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}`,
        });
      } else if (sizeCheck.status === "malformed_base64") {
        results.set(rowKey(row), {
          classification: "graph_metadata_size_mismatch_malformed_base64",
          detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — unique name match; Graph reported size ${match.size} vs DB size ${row.size}, and contentBytes was present but was not well-formed base64 (malformed) — not trusted.`,
          graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}`,
        });
      } else {
        results.set(rowKey(row), {
          classification: "graph_metadata_size_mismatch_bytes_differ",
          detail: `Mailbox ${mailbox}, Graph attachment id ${match.id} — unique name match; Graph reported size ${match.size}, DB recorded size ${row.size}, decoded contentBytes length ${sizeCheck.length} — none of these three agree; genuinely not recoverable from this response.`,
          graphAttachmentKey: `${mailbox}::${emailMessageId}::${match.id}`,
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
    graph_recoverable_metadata_size_mismatch: 0,
    graph_metadata_size_mismatch_bytes_differ: 0,
    graph_metadata_size_mismatch_bytes_unavailable: 0,
    graph_metadata_size_mismatch_malformed_base64: 0,
    graph_attachment_ambiguous: 0,
    graph_message_not_found: 0,
    graph_request_failed: 0,
    mailbox_unresolved: 0,
    no_email_correlation: 0,
  };
  // Distinct Graph attachment ids per classification — reveals when
  // several DISTINCT attachment ROWS (different tickets/replies) all
  // resolve to the SAME underlying Graph attachment, which a plain row
  // count alone hides (e.g. a real production run: 10 records, only 5
  // distinct Graph attachment ids behind them).
  const distinctGraphIdsByClassification = new Map<Classification, Set<string>>();
  for (const row of allRows) {
    const result = results.get(rowKey(row));
    if (!result) continue; // skipped this run due to --limit
    counts[result.classification]++;
    if (result.graphAttachmentKey) {
      if (!distinctGraphIdsByClassification.has(result.classification)) distinctGraphIdsByClassification.set(result.classification, new Set());
      distinctGraphIdsByClassification.get(result.classification)!.add(result.graphAttachmentKey);
    }
    if (result.classification !== "file_present") {
      console.log(`  [${result.classification}] ${row.kind} ${row.id} (${row.kind === "ticket" ? "ticketId" : "pendingTicketId"}=${row.ownerId}, mimeType=${row.mimeType}) — ${result.detail}`);
    }
  }

  console.log(`\nGraph requests made this run:        ${graphRequestsMade} (of --limit=${limit})`);
  console.log(`Rows not checked (limit reached):    ${notCheckedLimitReached}`);
  console.log("\n=== Summary (attachment-record counts) ===");
  for (const [bucket, count] of Object.entries(counts)) {
    const distinctIds = distinctGraphIdsByClassification.get(bucket as Classification);
    const suffix = distinctIds ? ` — ${distinctIds.size} distinct Graph attachment id${distinctIds.size === 1 ? "" : "s"}` : "";
    console.log(`${bucket.padEnd(38)} ${count}${suffix}`);
  }
  console.log("\nThis script wrote nothing — no DB rows changed, no files written, no emails modified or re-ingested.");
  await prisma.$disconnect();
}

main();
