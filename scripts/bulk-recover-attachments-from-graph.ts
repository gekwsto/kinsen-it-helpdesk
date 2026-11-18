/**
 * Safely recovers MANY historical attachments by calling the existing
 * single-record tool (scripts/recover-attachment-from-graph.ts's
 * `recoverAttachment`) once per candidate, sequentially, never more than
 * one at a time. This file adds NO new matching, Graph-fetch, byte-
 * validation, or file-write logic of its own — every actual recovery
 * guarantee (exclusive publish, SHA-256 verification, path safety,
 * idempotency, never overwriting) comes from that one already-tested
 * function, reused unchanged. This is purely an orchestrator: select
 * candidates, freeze them into an approved manifest, then process exactly
 * that manifest, one record at a time, continuing past individual
 * failures but stopping immediately on anything systemic.
 *
 * WHY A MANIFEST, AND WHY APPROVAL IS SEPARATE FROM EXECUTION
 *   Candidate selection (scripts/attachment-graph-recovery-correlation.ts's
 *   selectRecoveryCandidates) reflects the DB's state at the moment it
 *   runs. If a bulk run simply re-selected candidates live and processed
 *   whatever it found, a record that becomes eligible seconds before
 *   (or during) a run — a brand new ticket attachment, say — could be
 *   swept into a batch an operator never actually reviewed. The manifest
 *   is a FROZEN, deterministic snapshot: `--generate-manifest` writes it
 *   to a file, as a plain {kind, id} list plus a SHA-256 of that exact
 *   list. Processing (`--manifest=<path> --confirm=<hash>`) requires the
 *   operator to supply that exact hash back, computed from the manifest's
 *   OWN entries (recomputed fresh here, never trusted from a field inside
 *   the same file) — a mismatch (the file changed since it was reviewed,
 *   or the wrong file/hash was passed) refuses to process anything. Only
 *   the entries actually listed in the approved manifest are EVER
 *   touched; new or unrelated records that exist in the live DB but
 *   aren't in that list are never processed, no matter how the live
 *   candidate set has changed since generation.
 *
 * WHAT A RUN DOES, IN ORDER
 *   1. `--generate-manifest --out=<path>`: selects candidates (locally
 *      missing AND with a verified, unique email correlation — the 11
 *      no_email_correlation records, and any mailbox-unresolved records,
 *      are excluded by construction, never guessed into eligibility),
 *      sorts them deterministically (by kind, then id), and writes the
 *      manifest file. Makes ZERO Graph calls — pure DB/filesystem reads,
 *      same as the bulk diagnostic's own --dry-run.
 *   2. The operator reviews the manifest file, then re-runs with
 *      `--manifest=<path> --confirm=<the manifest's own sha256>` (no
 *      --apply) — a REAL dry run: every listed record is independently
 *      re-verified against live DB/Graph state (recoverAttachment's own
 *      revalidation, exactly as the single-record tool does it), writing
 *      nothing, previewing every per-record outcome.
 *   3. Only once that preview looks correct: the SAME command, plus
 *      `--apply`, actually recovers each record, one at a time.
 *
 * FAILURE HANDLING
 *   A per-record failure (unsafe filename, no longer correlates, Graph
 *   message not found, name mismatch, byte-length mismatch, a benign
 *   transient Graph error) is logged and the batch CONTINUES to the next
 *   record — one bad record never blocks the rest. A SYSTEMIC failure
 *   (Graph isn't configured at all, Graph authentication/authorization is
 *   flatly rejected, or the storage layout itself looks compromised — a
 *   symlink escaping UPLOAD_DIR) ABORTS the entire remaining batch
 *   immediately — see recoverAttachment's own `systemic` flag (scripts/
 *   recover-attachment-from-graph.ts) and classifyGraphFailure (scripts/
 *   attachment-graph-recovery-correlation.ts), both reused here, not
 *   reimplemented. Records already processed before an abort keep their
 *   real outcomes; records after it are explicitly marked "not_attempted"
 *   — never silently dropped, never falsely reported as "failed."
 *
 * RESUMABILITY
 *   recoverAttachment's own existing-file check (before any Graph call)
 *   means re-running the SAME manifest after a partial or interrupted run
 *   is always safe: every already-recovered entry reports
 *   "already_present" with no further Graph call, and processing simply
 *   continues from wherever it actually left off. No separate resume
 *   state is needed or kept.
 *
 * SAFETY
 *   - Sequential only — a plain for-loop with one `await
 *     recoverAttachment(...)` per iteration. Never Promise.all/.map —
 *     no two records are ever written concurrently.
 *   - No new database writes of any kind, and no Graph write operations —
 *     identical guarantee to the single-record tool, since this never
 *     touches the DB or Graph directly; recoverAttachment does, and is
 *     unchanged.
 *   - Default dry-run at the batch level too: --apply is required even
 *     with an approved manifest in hand.
 *   - Never invoked automatically — purely an operator-run tool.
 *
 * Usage:
 *   npx tsx scripts/bulk-recover-attachments-from-graph.ts --generate-manifest --out=manifest.json
 *   npx tsx scripts/bulk-recover-attachments-from-graph.ts --manifest=manifest.json --confirm=<sha256>
 *   npx tsx scripts/bulk-recover-attachments-from-graph.ts --manifest=manifest.json --confirm=<sha256> --apply
 *   npx tsx scripts/bulk-recover-attachments-from-graph.ts --manifest=manifest.json --confirm=<sha256> --apply --report-out=report.json
 */
import fs from "fs/promises";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { selectRecoveryCandidates } from "@/scripts/attachment-graph-recovery-correlation";
import { recoverAttachment } from "@/scripts/recover-attachment-from-graph";

export type ManifestEntry = { kind: "ticket" | "pending"; id: string };

export type Manifest = {
  generatedAt: string;
  candidateCount: number;
  filePresentCount: number;
  noEmailCorrelationCount: number;
  mailboxUnresolvedCount: number;
  sha256: string;
  entries: ManifestEntry[];
};

/** Deterministic ordering (by kind, then id) so regenerating against the same DB state always produces the same file and the same hash. */
export function sortManifestEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Hashes ONLY the sorted {kind,id} entries — never any other field of the manifest — so this is recomputable from the entries alone and can never be satisfied by a tampered file that changed its entries but left an old hash sitting in some other field. */
export function computeManifestHash(entries: ManifestEntry[]): string {
  const sorted = sortManifestEntries(entries);
  const canonical = JSON.stringify(sorted.map((e) => ({ kind: e.kind, id: e.id })));
  return createHash("sha256").update(canonical).digest("hex");
}

/** Selects candidates fresh from the DB (zero Graph calls) and freezes them into a deterministic, hashed manifest. */
export async function generateManifest(): Promise<Manifest> {
  const selection = await selectRecoveryCandidates();
  const entries = sortManifestEntries(selection.candidates.map((r) => ({ kind: r.kind, id: r.id })));
  return {
    generatedAt: new Date().toISOString(),
    candidateCount: entries.length,
    filePresentCount: selection.filePresentCount,
    noEmailCorrelationCount: selection.noEmailCorrelationCount,
    mailboxUnresolvedCount: selection.mailboxUnresolvedCount,
    sha256: computeManifestHash(entries),
    entries,
  };
}

export type BulkRecordOutcome = {
  kind: "ticket" | "pending";
  id: string;
  status: "published" | "already_present" | "dry_run_verified" | "concurrent_winner_detected" | "failed" | "not_attempted";
  reason?: string;
  systemic?: boolean;
  mailbox?: string;
  graphAttachmentId?: string;
  expectedSize?: number;
  writtenSize?: number;
  sha256?: string;
};

export type BulkRunResult = {
  mode: "dry_run" | "apply";
  manifestSha256: string;
  totalEntries: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  notAttemptedCount: number;
  abortedEarly: boolean;
  abortReason?: string;
  records: BulkRecordOutcome[];
};

/**
 * Validates manifest entries STRUCTURALLY, from completely untrusted input
 * (a manifest is JSON parsed off disk — TypeScript's `Manifest` type on the
 * caller's side is a compile-time label, never a runtime guarantee about
 * what was actually in the file, so this treats `entries` as `unknown`
 * regardless of what type the caller claims). Catches: not an array, an
 * entry that isn't a plain object, an invalid `kind` (anything other than
 * the literal strings "ticket"/"pending" — wrong case, a number, missing),
 * an invalid `id` (not a non-empty string), and a DUPLICATE `(kind, id)`
 * pair appearing more than once (which would otherwise just run
 * recoverAttachment twice for the same record — harmless by itself thanks
 * to its own idempotency, but a manifest that isn't even internally
 * consistent should never be treated as "reviewed and approved as-is").
 * Runs BEFORE the confirm-hash check and before any Graph call or file
 * write — a malformed manifest is rejected on its own facts, not folded
 * into a generic hash-mismatch message.
 */
export function validateManifestEntries(entries: unknown): { ok: true; entries: ManifestEntry[] } | { ok: false; reason: string } {
  if (!Array.isArray(entries)) return { ok: false, reason: "Manifest entries is not an array." };
  const validated: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      return { ok: false, reason: `Manifest entry at index ${i} is not a plain object.` };
    }
    const kind = (e as Record<string, unknown>).kind;
    const id = (e as Record<string, unknown>).id;
    if (kind !== "ticket" && kind !== "pending") {
      return { ok: false, reason: `Manifest entry at index ${i} has an invalid kind (${JSON.stringify(kind)}) — must be exactly "ticket" or "pending".` };
    }
    if (typeof id !== "string" || id.length === 0) {
      return { ok: false, reason: `Manifest entry at index ${i} has an invalid id (${JSON.stringify(id)}) — must be a non-empty string.` };
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      return { ok: false, reason: `Manifest contains a duplicate entry: ${kind} ${id} appears more than once.` };
    }
    seen.add(key);
    validated.push({ kind, id });
  }
  return { ok: true, entries: validated };
}

/**
 * Processes an ALREADY-APPROVED manifest, one entry at a time, via the
 * existing single-record recoverAttachment — this function adds no
 * recovery logic of its own. Refuses outright (zero Graph calls, zero
 * file writes) if the entries are structurally invalid
 * (validateManifestEntries above) OR if `confirmHash` doesn't match a
 * FRESH hash recomputed from those (now-validated) entries right now —
 * see this file's own top-level doc comment for why that's the real
 * "cannot process without approval of THIS exact list" guarantee, not
 * merely a convention. Both checks run for EVERY call, dry-run or
 * `apply` alike — there is no code path that skips either one.
 */
export async function runBulkRecovery(manifest: { entries: unknown }, confirmHash: string, apply: boolean): Promise<{ ok: true; result: BulkRunResult } | { ok: false; reason: string }> {
  const validation = validateManifestEntries(manifest.entries);
  if (!validation.ok) {
    return { ok: false, reason: `Invalid manifest: ${validation.reason}` };
  }

  const recomputedHash = computeManifestHash(validation.entries);
  if (recomputedHash !== confirmHash) {
    return {
      ok: false,
      reason: `Confirmation hash does not match the manifest's own entries (recomputed ${recomputedHash}, you supplied ${confirmHash}) — refusing to process anything. The manifest file may have changed since it was reviewed, or the wrong --confirm value was given.`,
    };
  }

  const sortedEntries = sortManifestEntries(validation.entries);
  const records: BulkRecordOutcome[] = [];
  let abortedEarly = false;
  let abortReason: string | undefined;

  for (let i = 0; i < sortedEntries.length; i++) {
    const entry = sortedEntries[i];
    const result = await recoverAttachment(entry.kind, entry.id, apply);

    if (!result.ok) {
      records.push({ kind: entry.kind, id: entry.id, status: "failed", reason: result.reason, systemic: result.systemic });
      if (result.systemic) {
        abortedEarly = true;
        abortReason = `Systemic failure on ${entry.kind} attachment ${entry.id}: ${result.reason}`;
        for (let j = i + 1; j < sortedEntries.length; j++) {
          records.push({ kind: sortedEntries[j].kind, id: sortedEntries[j].id, status: "not_attempted", reason: "Batch aborted before this record was attempted (a prior record failed systemically)." });
        }
        break;
      }
      continue;
    }

    if (result.status === "already_present" || result.status === "concurrent_winner_detected") {
      records.push({ kind: entry.kind, id: entry.id, status: result.status });
    } else if (result.status === "dry_run_verified") {
      records.push({ kind: entry.kind, id: entry.id, status: "dry_run_verified", mailbox: result.mailbox, graphAttachmentId: result.graphAttachmentId, expectedSize: result.expectedSize, sha256: result.sha256 });
    } else {
      records.push({ kind: entry.kind, id: entry.id, status: "published", mailbox: result.mailbox, graphAttachmentId: result.graphAttachmentId, expectedSize: result.expectedSize, writtenSize: result.writtenSize, sha256: result.sha256 });
    }
  }

  const notAttemptedCount = records.filter((r) => r.status === "not_attempted").length;
  const succeededCount = records.filter((r) => r.status === "published" || r.status === "already_present" || r.status === "dry_run_verified" || r.status === "concurrent_winner_detected").length;
  const failedCount = records.filter((r) => r.status === "failed").length;

  return {
    ok: true,
    result: {
      mode: apply ? "apply" : "dry_run",
      manifestSha256: confirmHash,
      totalEntries: sortedEntries.length,
      processedCount: records.length - notAttemptedCount,
      succeededCount,
      failedCount,
      notAttemptedCount,
      abortedEarly,
      abortReason,
      records,
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

type CliArgs = { mode: "generate"; out: string } | { mode: "process"; manifestPath: string; confirm: string; apply: boolean; reportOut: string | null };

function parseArgs(argv: string[]): CliArgs {
  if (argv.includes("--generate-manifest")) {
    const outArg = argv.find((a) => a.startsWith("--out="));
    if (!outArg || outArg.slice("--out=".length).length === 0) {
      console.error("Pass --out=<path> to write the generated manifest to.");
      process.exit(1);
    }
    return { mode: "generate", out: outArg.slice("--out=".length) };
  }

  const manifestArg = argv.find((a) => a.startsWith("--manifest="));
  const confirmArg = argv.find((a) => a.startsWith("--confirm="));
  if (!manifestArg || !confirmArg) {
    console.error("Pass --manifest=<path> --confirm=<hash> to process an approved manifest (add --apply to write; omit for a dry run), or --generate-manifest --out=<path> to create one.");
    process.exit(1);
  }
  const reportOutArg = argv.find((a) => a.startsWith("--report-out="));
  return {
    mode: "process",
    manifestPath: manifestArg.slice("--manifest=".length),
    confirm: confirmArg.slice("--confirm=".length),
    apply: argv.includes("--apply"),
    reportOut: reportOutArg ? reportOutArg.slice("--report-out=".length) : null,
  };
}

function printBulkReport(result: BulkRunResult) {
  console.log(`\n=== Bulk recovery report — ${result.mode === "apply" ? "APPLY" : "DRY RUN"} ===`);
  console.log(`Manifest SHA-256:  ${result.manifestSha256}`);
  console.log(`Total entries:     ${result.totalEntries}`);
  console.log(`Processed:         ${result.processedCount}`);
  console.log(`Succeeded:         ${result.succeededCount}`);
  console.log(`Failed:            ${result.failedCount}`);
  console.log(`Not attempted:     ${result.notAttemptedCount}`);
  if (result.abortedEarly) console.log(`\n*** BATCH ABORTED EARLY — ${result.abortReason} ***`);
  console.log("\nPer-record outcomes:");
  for (const r of result.records) {
    const detail = r.reason ? ` — ${r.reason}` : r.sha256 ? ` — sha256=${r.sha256}, size=${r.writtenSize ?? r.expectedSize}` : "";
    console.log(`  [${r.status}] ${r.kind} ${r.id}${detail}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  try {
    if (args.mode === "generate") {
      const manifest = await generateManifest();
      try {
        await fs.writeFile(args.out, JSON.stringify(manifest, null, 2), { flag: "wx" });
      } catch (err) {
        console.log(`\nCould not write manifest file (it may already exist — never overwritten): ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
      console.log("\n=== Manifest generated ===");
      console.log(`Written to:               ${args.out}`);
      console.log(`Candidates (entries):     ${manifest.candidateCount}`);
      console.log(`Already present locally:  ${manifest.filePresentCount}`);
      console.log(`No email correlation:     ${manifest.noEmailCorrelationCount} (excluded, never guessed)`);
      console.log(`Mailbox unresolved:       ${manifest.mailboxUnresolvedCount} (excluded, never guessed)`);
      console.log(`Manifest SHA-256:         ${manifest.sha256}`);
      console.log("\nReview the manifest file, then re-run with:");
      console.log(`  --manifest=${args.out} --confirm=${manifest.sha256}`);
      console.log("(add --apply once the dry-run preview looks correct)");
      return;
    }

    let manifest: Manifest;
    try {
      const raw = await fs.readFile(args.manifestPath, "utf8");
      manifest = JSON.parse(raw);
    } catch (err) {
      console.log(`\nCould not read/parse manifest file: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    if (!manifest || !Array.isArray(manifest.entries)) {
      console.log("\nManifest file does not have the expected shape (missing an entries array) — refusing to process.");
      process.exitCode = 1;
      return;
    }

    const outcome = await runBulkRecovery(manifest, args.confirm, args.apply);
    if (!outcome.ok) {
      console.log(`\nABORTED before processing anything: ${outcome.reason}`);
      process.exitCode = 1;
      return;
    }

    printBulkReport(outcome.result);
    // A failure writing the --report-out file is its OWN distinct failure,
    // never folded into — or hidden behind — the batch's own success
    // summary printed just above. Always forces a non-zero exit, even if
    // the recovery batch itself was fully successful: the operator asked
    // for a saved structured report, and it genuinely was not saved.
    if (args.reportOut) {
      try {
        await fs.writeFile(args.reportOut, JSON.stringify(outcome.result, null, 2));
        console.log(`\nStructured report written to: ${args.reportOut}`);
      } catch (err) {
        console.log(`\n*** REPORT FILE WRITE FAILED — the recovery batch above completed as shown, but the structured report was NOT saved: ${err instanceof Error ? err.message : String(err)} ***`);
        process.exitCode = 1;
        return;
      }
    }
    if (outcome.result.abortedEarly || outcome.result.failedCount > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Only run the CLI when this file is executed directly, not when
// generateManifest/runBulkRecovery are imported by the focused regression
// test — same convention as scripts/recover-attachment-from-graph.ts.
if (require.main === module) {
  main();
}
