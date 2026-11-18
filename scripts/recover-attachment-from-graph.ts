/**
 * Recovers the BYTES of ONE explicitly-named TicketAttachment or
 * PendingTicketAttachment record whose file is missing from local storage,
 * by re-fetching the original email from Microsoft Graph. This is the
 * single-record WRITE counterpart to the read-only bulk diagnostic
 * (scripts/diagnose-attachment-graph-recovery.ts) — that script only ever
 * classifies; this one, and only this one, is allowed to write a file.
 *
 * Deliberately NOT a bulk recovery tool, for the same reason
 * scripts/repair-flattened-table-layout-body.ts (the prior art this follows)
 * isn't one: recovery is destructive-adjacent (it creates a new file on
 * disk) and must be reviewable one record at a time, never a scripted sweep
 * that could compound a bad assumption across many rows unattended.
 *
 * WHAT THIS DOES, IN ORDER
 *   1. Loads the named TicketAttachment/PendingTicketAttachment row. Not
 *      found -> abort, no further action.
 *   2. Checks row.filename against isSafeStoredFilename (lib/attachment-
 *      policy.ts) BEFORE anything else — an unsafe filename aborts
 *      immediately, before any Graph call or filesystem access of any kind.
 *   3. Checks BOTH the canonical private path and the legacy public path
 *      (scripts/attachment-graph-recovery-correlation.ts's storagePaths) —
 *      if the file already exists at EITHER, this is a no-op: reported as
 *      "already present," never re-fetched, never overwritten.
 *   4. Resolves the row's source emailMessageId and its EXACTLY ONE
 *      resolved mailbox (shared correlation logic — see that module's own
 *      doc comment) — zero or ambiguous correlation aborts with no Graph
 *      call made at all.
 *   5. Fetches the message fresh from Graph by internetMessageId and
 *      verifies Graph returned the SAME internetMessageId that was asked
 *      for — this is the "revalidate immediately before recovery" step:
 *      every check in this list runs inside THIS single invocation, never
 *      reusing any earlier diagnostic run's cached conclusion.
 *   6. Finds the EXACTLY ONE attachment on that message sharing this row's
 *      originalName (findUniqueAttachmentByName, shared with the
 *      diagnostic) — zero or 2+ matches aborts; Graph's reported `size` is
 *      never used to disambiguate (see that module's own doc comment).
 *   7. Strictly validates the matched attachment's contentBytes as
 *      well-formed base64 (scripts/attachment-graph-recovery-base64.ts's
 *      isStrictlyValidBase64 — the same stack-safe, non-regex validator the
 *      diagnostic uses) and decodes it. The decoded length MUST exactly
 *      equal the row's own DB-recorded size — Graph's reported attachment
 *      `size` is NEVER trusted or compared against; only the DB's own
 *      historical record of what this file's size actually was matters.
 *      Any mismatch (absent, malformed, or decodes to the wrong length)
 *      aborts — nothing is ever written from unverified or partial bytes.
 *   8. With --apply only: writes the decoded bytes to a per-run temporary
 *      file (writeAndVerifyTempFile — exclusive creation, then re-reads the
 *      file from disk and compares its own hash/length against the
 *      decoded buffer, catching any disk-level write corruption before
 *      publication), then atomically publishes it to the canonical path
 *      (publishRecoveredFile — an exclusive hard-link, which fails closed
 *      with EEXIST rather than silently overwriting if the destination
 *      already exists, covering a concurrent recovery attempt or a file
 *      that appeared between step 3's check and now).
 *   9. Produces a concise audit report: record id, kind, mailbox, the
 *      Graph attachment's own id, expected size, written size, and a
 *      SHA-256 of the recovered content — NEVER the attachment's
 *      originalName/filename, its bytes, any email body/subject, or any
 *      credential/token (same restraint the bulk diagnostic's own OUTPUT
 *      safety section applies).
 *
 * SAFETY
 *   - --dry-run is the DEFAULT (also true with no flags) — never writes.
 *     Still makes exactly ONE real (read-only) Graph request, the same
 *     verification an --apply run would make, so a dry run's report is a
 *     genuine preview, not a guess. --apply is required to write anything.
 *   - Never overwrites an existing file, by construction, in TWO
 *     independent ways: the early existence check in step 3, AND the
 *     exclusive-hard-link publish in step 8 (which fails closed on EEXIST
 *     even if something else created the file in between).
 *   - Writes ONLY a new file under UPLOAD_DIR, at the EXACT path the row's
 *     own EXISTING filename already implies. Never creates, updates, or
 *     deletes any database row (TicketAttachment/PendingTicketAttachment/
 *     Ticket/PendingTicket/TicketMessage/EmailProcessingLog) — the
 *     attachment record, its filename, originalName, mimeType, and ticket
 *     association are all exactly as they were before this ran. Never
 *     marks a Graph message read or moves it (getMessageByInternetMessageId
 *     is a plain GET).
 *   - Isolated from normal request processing and email ingestion: this is
 *     a standalone operator script, never imported by any API route, cron
 *     job, or lib/ticket-email-service.ts / lib/services/pending-ticket-
 *     service.ts ingestion path. It reads Ticket/PendingTicket/
 *     TicketAttachment/PendingTicketAttachment/TicketMessage/
 *     EmailProcessingLog rows and writes exactly one file; nothing else in
 *     the running application is touched or even imported.
 *   - On ANY failure after a temporary file is created, that temp file is
 *     always cleaned up (a `finally` covers every return/throw path) —
 *     never left behind, and never at the cost of touching a pre-existing
 *     file, which the exclusive-create ('wx') temp-file write and the
 *     exclusive-hard-link publish both structurally guarantee.
 *   - Never invoked automatically — purely an operator-run tool, one
 *     record at a time.
 *
 * Usage:
 *   npx tsx scripts/recover-attachment-from-graph.ts --kind=ticket --id=<id>
 *   npx tsx scripts/recover-attachment-from-graph.ts --kind=pending --id=<id> --apply
 */
import fs from "fs/promises";
import path from "path";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, isSafeStoredFilename, resolvesInsideDir } from "@/lib/attachment-policy";
import { microsoftGraph, GraphConfigurationError } from "@/lib/microsoft-graph";
import { isStrictlyValidBase64 } from "@/scripts/attachment-graph-recovery-base64";
import { type Row, fileExistsLocally, storagePaths, resolveMailbox, resolveEmailMessageId, findUniqueAttachmentByName, classifyGraphFailure } from "@/scripts/attachment-graph-recovery-correlation";

// `systemic: true` marks a failure that would recur IDENTICALLY for every
// other record too (Graph isn't configured at all, authentication/
// authorization is flatly rejected, or the storage layout itself looks
// compromised — a symlink escaping UPLOAD_DIR) — set ONLY on those few
// branches below. Every other failure (unsafe filename, no correlation,
// unresolved mailbox, name mismatch, byte mismatch, …) is specific to
// THIS one record and leaves `systemic` unset. scripts/bulk-recover-
// attachments-from-graph.ts uses this to decide "abort the whole batch"
// vs. "log this record and continue to the next one."
export type RecoveryResult =
  | { ok: false; reason: string; systemic?: boolean }
  | { ok: true; recordId: string; kind: "ticket" | "pending"; status: "already_present"; destinationPath: string }
  | { ok: true; recordId: string; kind: "ticket" | "pending"; status: "dry_run_verified"; mailbox: string; graphAttachmentId: string; expectedSize: number; sha256: string; destinationPath: string }
  | { ok: true; recordId: string; kind: "ticket" | "pending"; status: "published"; mailbox: string; graphAttachmentId: string; expectedSize: number; writtenSize: number; sha256: string; destinationPath: string }
  | { ok: true; recordId: string; kind: "ticket" | "pending"; status: "concurrent_winner_detected"; destinationPath: string };

async function loadRow(kind: "ticket" | "pending", id: string): Promise<Row | null> {
  if (kind === "pending") {
    const a = await prisma.pendingTicketAttachment.findUnique({
      where: { id },
      select: { id: true, pendingTicketId: true, filename: true, originalName: true, mimeType: true, size: true },
    });
    if (!a) return null;
    return { kind: "pending", id: a.id, ownerId: a.pendingTicketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size };
  }
  const a = await prisma.ticketAttachment.findUnique({
    where: { id },
    select: { id: true, ticketId: true, filename: true, originalName: true, mimeType: true, size: true },
  });
  if (!a) return null;
  return { kind: "ticket", id: a.id, ownerId: a.ticketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size };
}

type ReadFileImpl = (path: string) => Promise<Buffer>;

/**
 * Writes `buffer` to `tempPath` via EXCLUSIVE creation (`wx` — fails if
 * tempPath somehow already exists, never truncates/overwrites anything),
 * then re-reads the file back from disk and compares ITS OWN hash/length
 * against `buffer` — catching any disk-level write corruption before this
 * content is ever published to the real destination. On any mismatch or
 * error, the temp file is removed and a clear failure reason is returned —
 * never thrown — so a caller never has to distinguish "this specific
 * verification failed" from an unrelated crash.
 *
 * `readFileImpl` defaults to `fs.readFile` and exists purely as a test
 * seam (scripts/test-recover-attachment-from-graph.ts injects a fake
 * implementation that returns different bytes than were written, to prove
 * the mismatch path is detected and cleaned up — there is no reliable way
 * to provoke a REAL disk-corruption mismatch in a test).
 */
export async function writeAndVerifyTempFile(buffer: Buffer, tempPath: string, readFileImpl: ReadFileImpl = fs.readFile): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const expectedSha256 = createHash("sha256").update(buffer).digest("hex");
  try {
    await fs.writeFile(tempPath, buffer, { flag: "wx" });
  } catch (err) {
    return { ok: false, reason: `Failed to write temp file: ${err instanceof Error ? err.message : String(err)}` };
  }
  // From here on, tempPath EXISTS — any failure path below must clean it
  // up explicitly (there is no file to leave behind on a verification
  // failure). On SUCCESS, tempPath is deliberately left in place: the
  // caller (recoverAttachment, via publishRecoveredFile) still needs it
  // to exist to hard-link it to the real destination — this function's
  // own job is "write once, verify once," never deciding publication.
  try {
    const writtenBuf = await readFileImpl(tempPath);
    const writtenSha256 = createHash("sha256").update(writtenBuf).digest("hex");
    if (writtenBuf.length !== buffer.length || writtenSha256 !== expectedSha256) {
      await fs.unlink(tempPath).catch(() => {});
      return { ok: false, reason: `Temp file verification failed after write (length ${writtenBuf.length} vs expected ${buffer.length}, hash match: ${writtenSha256 === expectedSha256}) — possible disk-level corruption during write.` };
    }
    return { ok: true, sha256: expectedSha256 };
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    return { ok: false, reason: `Failed to verify temp file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Atomically publishes `tempPath` to `finalPath` via an EXCLUSIVE hard
 * link — `fs.link` fails closed with EEXIST if `finalPath` already
 * exists, unlike `fs.rename`, which would silently overwrite it. This is
 * the actual "never overwrite, even under a race" guarantee: if another
 * process (a second concurrent recovery attempt, or a file that appeared
 * out-of-band between this run's own early existence check and this exact
 * instant) created `finalPath` first, this returns "already_exists"
 * rather than clobbering it or throwing. Never deletes a pre-existing
 * file at `finalPath` either way. `tempPath` itself is a dangling second
 * link to the same inode after a successful publish, so it's removed
 * once the link exists — the caller never has to clean it up on success.
 */
export async function publishRecoveredFile(tempPath: string, finalPath: string): Promise<"published" | "already_exists"> {
  try {
    await fs.link(tempPath, finalPath);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") return "already_exists";
    throw err;
  }
  await fs.unlink(tempPath).catch(() => {});
  return "published";
}

/**
 * Recovers ONE attachment's bytes. Dry-run (apply === false) still
 * performs every verification step, including the real Graph fetch — it
 * only skips the filesystem write. See this file's own top-level doc
 * comment for the full ordered list of what each step does and why.
 */
export async function recoverAttachment(kind: "ticket" | "pending", id: string, apply: boolean): Promise<RecoveryResult> {
  const row = await loadRow(kind, id);
  if (!row) return { ok: false, reason: `No ${kind === "ticket" ? "TicketAttachment" : "PendingTicketAttachment"} found with id ${id}.` };

  // Filename safety FIRST — before any Graph call or filesystem access of
  // any kind, mirroring the authenticated download routes' own guard.
  if (!isSafeStoredFilename(row.filename)) {
    return { ok: false, reason: `Refusing to recover ${kind} attachment ${id} — unsafe filename on record.` };
  }

  const { privatePath, legacyPath } = storagePaths(row);
  const dir = row.kind === "ticket" ? path.join(UPLOAD_DIR, row.ownerId) : path.join(UPLOAD_DIR, "pending", row.ownerId);
  if (!resolvesInsideDir(privatePath, dir)) {
    return { ok: false, reason: `Refusing to recover ${kind} attachment ${id} — resolved destination path escaped its expected directory.` };
  }

  // Never overwrite — check 1 of 2 (see publishRecoveredFile for check 2,
  // the race-safe one). Checks BOTH the canonical and legacy locations, so
  // a file that was already migrated/recovered under either is correctly
  // left alone.
  if ((await fileExistsLocally(privatePath)) || (await fileExistsLocally(legacyPath))) {
    return { ok: true, recordId: id, kind, status: "already_present", destinationPath: privatePath };
  }

  const emailMessageId = await resolveEmailMessageId(row);
  if (!emailMessageId) return { ok: false, reason: `No emailMessageId on the owning record for ${kind} attachment ${id} — not an email-ingested attachment, or source metadata was never recorded.` };

  const mailboxResult = await resolveMailbox(emailMessageId);
  if (!mailboxResult.ok) return { ok: false, reason: `Mailbox could not be uniquely resolved for ${kind} attachment ${id} (EmailProcessingLog has zero, or more than one distinct, mailbox recorded for this message) — refusing to guess.` };

  let message;
  try {
    message = await microsoftGraph.getMessageByInternetMessageId(mailboxResult.mailbox, emailMessageId);
  } catch (err) {
    if (err instanceof GraphConfigurationError) return { ok: false, reason: `Microsoft Graph is not configured in this environment: ${err.message}`, systemic: true };
    const classified = classifyGraphFailure(err);
    return { ok: false, reason: `Graph request failed (message existence unknown, never treated as "not found"): ${classified.description}`, systemic: classified.systemic };
  }
  if (!message || message.internetMessageId !== emailMessageId) {
    return { ok: false, reason: `Graph request succeeded but found no message with internetMessageId ${emailMessageId} in mailbox ${mailboxResult.mailbox} (or returned a mismatched one) — refusing to recover from an unverified source.` };
  }

  if (!message.attachments || message.attachments.length === 0) {
    return { ok: false, reason: `Source message found (mailbox ${mailboxResult.mailbox}) but its attachments collection is missing or empty — nothing to recover from.` };
  }

  const nameMatch = findUniqueAttachmentByName(message.attachments, row.originalName);
  if (nameMatch.status === "none") return { ok: false, reason: `No attachment on the source message (mailbox ${mailboxResult.mailbox}) shares this row's originalName.` };
  if (nameMatch.status === "ambiguous") return { ok: false, reason: `${nameMatch.count} attachments on the source message share this row's originalName — ambiguous, refusing to guess which one.` };
  const match = nameMatch.match;

  // Strict base64 + exact decoded-length verification against the DB's
  // OWN recorded size — Graph's reported attachment `size` is never read
  // or compared here at all; only the historical DB value matters.
  if (!isStrictlyValidBase64(match.contentBytes ?? "")) {
    return { ok: false, reason: `Graph attachment ${match.id} (mailbox ${mailboxResult.mailbox}) has contentBytes that is absent or not well-formed base64 — refusing to recover.` };
  }
  const decoded = Buffer.from(match.contentBytes!, "base64");
  if (decoded.length !== row.size) {
    return { ok: false, reason: `Graph attachment ${match.id} (mailbox ${mailboxResult.mailbox}) decoded to ${decoded.length} bytes, but the DB record for ${kind} attachment ${id} expects ${row.size} bytes — refusing to recover a byte mismatch.` };
  }
  const sha256 = createHash("sha256").update(decoded).digest("hex");

  if (!apply) {
    return { ok: true, recordId: id, kind, status: "dry_run_verified", mailbox: mailboxResult.mailbox, graphAttachmentId: match.id, expectedSize: row.size, sha256, destinationPath: privatePath };
  }

  await fs.mkdir(dir, { recursive: true });

  // Symlink-escape guard: isSafeStoredFilename/resolvesInsideDir above are
  // purely LEXICAL (path.resolve never follows symlinks), so neither would
  // catch an intermediate directory component that is itself a symlink
  // pointing outside UPLOAD_DIR (e.g. if UPLOAD_DIR/<ticketId> had somehow
  // become a symlink). fs.realpath resolves every symlink in the chain, so
  // comparing the REAL destination directory against the REAL UPLOAD_DIR
  // root catches that case even though the lexical checks above cannot.
  // Safe to call now — fs.mkdir just above guarantees dir (and therefore
  // every ancestor including UPLOAD_DIR itself) exists.
  const [realDir, realUploadRoot] = await Promise.all([fs.realpath(dir), fs.realpath(UPLOAD_DIR)]);
  if (!resolvesInsideDir(realDir, realUploadRoot)) {
    return { ok: false, reason: `Refusing to recover ${kind} attachment ${id} — the destination directory resolves (after following symlinks) outside UPLOAD_DIR.`, systemic: true };
  }

  const tempPath = path.join(dir, `.recover-${randomBytes(8).toString("hex")}.tmp`);

  // A `finally` guarantees tempPath is never left behind, on ANY exit path
  // below — writeAndVerifyTempFile already cleans up after itself on its
  // OWN failures, and publishRecoveredFile removes tempPath itself on a
  // successful publish, so this is a harmless no-op (ENOENT, ignored) in
  // both of those cases; it's load-bearing only for the "already_exists"
  // branch (publishRecoveredFile deliberately leaves tempPath in place
  // there) and for an unexpected, non-EEXIST error from fs.link.
  try {
    const writeResult = await writeAndVerifyTempFile(decoded, tempPath);
    if (!writeResult.ok) return { ok: false, reason: writeResult.reason };

    let publishResult: "published" | "already_exists";
    try {
      publishResult = await publishRecoveredFile(tempPath, privatePath);
    } catch (err) {
      return { ok: false, reason: `Failed to publish recovered file: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (publishResult === "already_exists") {
      return { ok: true, recordId: id, kind, status: "concurrent_winner_detected", destinationPath: privatePath };
    }
    return { ok: true, recordId: id, kind, status: "published", mailbox: mailboxResult.mailbox, graphAttachmentId: match.id, expectedSize: row.size, writtenSize: decoded.length, sha256: writeResult.sha256, destinationPath: privatePath };
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const kindArg = argv.find((a) => a.startsWith("--kind="));
  const idArg = argv.find((a) => a.startsWith("--id="));
  if (!kindArg || (kindArg.slice("--kind=".length) !== "ticket" && kindArg.slice("--kind=".length) !== "pending")) {
    console.error("Pass --kind=ticket or --kind=pending.");
    process.exit(1);
  }
  if (!idArg || idArg.slice("--id=".length).length === 0) {
    console.error("Pass --id=<attachmentId>.");
    process.exit(1);
  }
  const kind = kindArg.slice("--kind=".length) as "ticket" | "pending";
  const id = idArg.slice("--id=".length);
  return { apply, kind, id };
}

function printReport(result: RecoveryResult) {
  if (!result.ok) {
    console.log(`\nABORTED — nothing written: ${result.reason}`);
    return;
  }
  console.log(`\nRecord:              ${result.kind} attachment ${result.recordId}`);
  console.log(`Status:              ${result.status}`);
  console.log(`Destination path:    ${result.destinationPath}`);
  if (result.status === "dry_run_verified" || result.status === "published") {
    console.log(`Mailbox:             ${result.mailbox}`);
    console.log(`Graph attachment id: ${result.graphAttachmentId}`);
    console.log(`Expected size:       ${result.expectedSize} bytes`);
    if (result.status === "published") console.log(`Written size:        ${result.writtenSize} bytes`);
    console.log(`SHA-256:             ${result.sha256}`);
  }
}

async function main() {
  const { apply, kind, id } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Single-attachment Graph recovery — ${apply ? "APPLY" : "DRY RUN"} ===`);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  try {
    const result = await recoverAttachment(kind, id, apply);
    printReport(result);
    if (!result.ok) process.exitCode = 1;
    else if (!apply && result.status === "dry_run_verified") console.log("\nThis was a dry run — nothing was written. Re-run with --apply to recover this file.");
  } finally {
    await prisma.$disconnect();
  }
}

// Only run the CLI when this file is executed directly, not when
// recoverAttachment/writeAndVerifyTempFile/publishRecoveredFile are
// imported by the focused regression test — same convention as
// scripts/repair-flattened-table-layout-body.ts.
if (require.main === module) {
  main();
}
