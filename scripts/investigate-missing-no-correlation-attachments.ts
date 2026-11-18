/**
 * READ-ONLY investigation of the final, un-Graph-recoverable attachments:
 * TicketAttachment rows that are missing from local storage AND have no
 * emailMessageId anywhere in their ownership chain (no_email_correlation —
 * see scripts/attachment-graph-recovery-correlation.ts's resolveEmailMessageId,
 * reused here unchanged). These can never be recovered from Microsoft Graph
 * — there is no originating email to re-fetch — so this script never calls
 * microsoftGraph at all (no speculative Graph matching, by construction,
 * not merely by convention). The only PendingTicketAttachment rows that
 * exist always have a PendingTicket with a NOT NULL, unique emailMessageId
 * (see prisma/schema.prisma) — so every no_email_correlation row is
 * necessarily a TicketAttachment, never a PendingTicketAttachment.
 *
 * Does NOT recover, copy, move, or delete anything. Does NOT write to the
 * database. Does NOT call Microsoft Graph. Purely gathers DB metadata and
 * searches a small, explicit, operator-controlled set of local directories
 * read-only for name/size candidates — never a broad filesystem walk.
 *
 * WHAT THIS REPORTS, PER MISSING ROW
 *   - Ticket identity: ticketNumber, title, source, createdAt, whether the
 *     row's filename passes isSafeStoredFilename.
 *   - Attachment identity: id, originalName, stored filename, mimeType,
 *     recorded size, createdAt.
 *   - Email-correlation context (read-only observation, NEVER an invented
 *     identity): the ticket's own emailMessageId (expected null), and
 *     whether ANY TicketMessage on this ticket has a non-null
 *     emailMessageId (i.e. the ticket received at least one genuine email
 *     reply even though it wasn't itself created from one) — reported as a
 *     fact, never used to guess a source for THIS attachment.
 *   - Source candidates found while searching the canonical storage
 *     locations (UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR) PLUS any
 *     operator-supplied --extra-path directories, classified strictly:
 *       "exact_filename_and_size_match" — a file with the IDENTICAL stored
 *         filename (a crypto.randomUUID()-prefixed name — see
 *         lib/attachment-policy.ts's generateStoredFilename — for which an
 *         unrelated coincidental collision is not realistically possible)
 *         AND the identical recorded size exists at the candidate location.
 *         This is the strongest signal this script can produce, but it is
 *         STILL NOT a content/hash verification — reported as a strong
 *         recovery CANDIDATE, never as confirmed-identical content.
 *       "originalname_and_size_match" — a file whose name contains the
 *         sanitized originalName AND matches the recorded size exists —
 *         weaker (a different backup convention could coincidentally share
 *         both).
 *       "size_only_match" / "filename_only_match" — explicitly flagged as
 *         coincidental, NEVER treated as evidence of recoverability on
 *         their own (constraint: do not treat equal size or filename alone
 *         as proof of identical contents).
 *     A row with an EMPTY `candidates` array ("no_candidate_found," in the
 *     printed report) means ONLY "not found within the specific locations
 *     this run actually searched" — see `searchedLocations` on each report
 *     row (the exact, symlink-resolved directories this run checked for
 *     THIS row) — NEVER "confirmed permanently unrecoverable." A different
 *     run with a wider --extra-path or --scan-whole-upload-tree could still
 *     find something; this field makes exactly what was/wasn't checked
 *     legible rather than leaving it implicit.
 *
 * SEARCH SCOPE (never a broad scan without explicit operator approval)
 *   - Always searches exactly this row's own expected directories under
 *     UPLOAD_DIR and LEGACY_PUBLIC_UPLOAD_DIR (the two canonical locations
 *     already used throughout this recovery toolset).
 *   - `--extra-path=<dir>` (repeatable) adds any further operator-named
 *     directory to search (e.g. a read-only-mounted host backup snapshot) —
 *     never invented or assumed; a path is searched ONLY if explicitly
 *     passed.
 *   - `--scan-whole-upload-tree` additionally searches every OTHER ticket's
 *     own directory under UPLOAD_DIR/LEGACY_PUBLIC_UPLOAD_DIR for a
 *     same-name-and-size file (catches a duplicate-upload scenario — the
 *     same file attached to two different tickets, one of which still has
 *     its copy) — OFF by default, since it is a wider scan than one row's
 *     own directory, even though it stays within the already-approved
 *     storage root.
 *
 * SAFETY
 *   - No --apply mode exists — this script is READ-ONLY, full stop.
 *   - Never calls microsoftGraph.
 *   - Never invoked automatically — purely an operator-run investigation.
 *
 * Usage:
 *   npx tsx scripts/investigate-missing-no-correlation-attachments.ts
 *   npx tsx scripts/investigate-missing-no-correlation-attachments.ts --extra-path=/mnt/backup-snapshot/uploads
 *   npx tsx scripts/investigate-missing-no-correlation-attachments.ts --scan-whole-upload-tree
 *   npx tsx scripts/investigate-missing-no-correlation-attachments.ts --report-out=investigation-report.json
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR, isSafeStoredFilename, resolvesInsideDir } from "@/lib/attachment-policy";
import { fileExistsLocally, storagePaths, resolveEmailMessageId, type Row } from "@/scripts/attachment-graph-recovery-correlation";

export type CandidateMatch = {
  location: string;
  foundFilename: string;
  foundSize: number;
  classification: "exact_filename_and_size_match" | "originalname_and_size_match" | "size_only_match" | "filename_only_match";
};

export type MissingRowReport = {
  attachmentId: string;
  ticketId: string;
  ticketNumber: number;
  ticketTitle: string;
  ticketSource: string;
  ticketCreatedAt: string;
  ticketHasAnyEmailReply: boolean;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  attachmentCreatedAt: string;
  filenameIsSafe: boolean;
  /**
   * The EXACT, symlink-resolved directories actually searched for this row
   * — always present, even when `candidates` is empty. An empty
   * `candidates` array means "not found within THESE specific locations,"
   * never "confirmed unrecoverable" — this list is what makes that
   * distinction checkable rather than implicit: a reader comparing this
   * list against what's actually been searched can see directly whether
   * other locations (a backup not yet supplied via --extra-path, for
   * instance) remain to be checked.
   */
  searchedLocations: string[];
  candidates: CandidateMatch[];
};

function sanitizedOriginalNameFragment(originalName: string): string {
  // Mirrors lib/attachment-policy.ts's own sanitizeAttachmentFilename —
  // deliberately NOT importing/calling it directly (that function also
  // gets re-used at WRITE time elsewhere; duplicating the one-line regex
  // here keeps this purely-read-only script from needing to reason about
  // whether importing it could ever have a write-adjacent side effect —
  // it has none, but this is a one-line, trivially-reviewable duplication,
  // not a reimplementation of any matching/recovery logic).
  return originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Resolves `dir` through any symlinks (fs.realpath) and confirms the
 * result still lies within `approvedRoot`'s OWN real, symlink-resolved
 * path — never a lexical string comparison, which an intermediate
 * directory component that is itself a symlink could defeat (e.g. if
 * UPLOAD_DIR/<ticketId> had somehow become a symlink pointing outside
 * UPLOAD_DIR, a plain fs.readdir(dir) would silently follow it and list
 * whatever it actually points to). Returns null — meaning "never search
 * this" — if `dir` doesn't exist, `approvedRoot` doesn't exist, or the
 * resolved path escapes; this is the ONLY gate standing between "the
 * canonical/whole-tree directories this script computes" and the
 * filesystem actually being read, applied to every such directory before
 * it is ever opened. Deliberately NOT applied to --extra-path directories
 * — those are named directly by the operator as the explicit approval for
 * exactly that path, with no implied "root" they could be checked against.
 */
async function resolveWithinApprovedRoot(dir: string, approvedRoot: string): Promise<string | null> {
  try {
    const [realDir, realRoot] = await Promise.all([fs.realpath(dir), fs.realpath(approvedRoot)]);
    return resolvesInsideDir(realDir, realRoot) ? realDir : null;
  } catch {
    return null;
  }
}

async function listDirSafe(dir: string): Promise<Array<{ name: string; size: number }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: Array<{ name: string; size: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      files.push({ name: entry.name, size: stat.size });
    }
    return files;
  } catch {
    return [];
  }
}

function classifyCandidate(found: { name: string; size: number }, row: Row, originalNameFragment: string): CandidateMatch["classification"] | null {
  const nameMatches = found.name === row.filename;
  const originalNameMatches = found.name.includes(originalNameFragment) && originalNameFragment.length > 0;
  const sizeMatches = found.size === row.size;
  if (nameMatches && sizeMatches) return "exact_filename_and_size_match";
  if (originalNameMatches && sizeMatches) return "originalname_and_size_match";
  if (sizeMatches) return "size_only_match";
  if (nameMatches || originalNameMatches) return "filename_only_match";
  return null;
}

async function searchDirectoryForCandidates(dir: string, row: Row, originalNameFragment: string): Promise<CandidateMatch[]> {
  const files = await listDirSafe(dir);
  const matches: CandidateMatch[] = [];
  for (const f of files) {
    const classification = classifyCandidate(f, row, originalNameFragment);
    if (classification) matches.push({ location: dir, foundFilename: f.name, foundSize: f.size, classification });
  }
  return matches;
}

/** Every ticket-level directory that currently exists under `root` (one level deep) — used only by --scan-whole-upload-tree, and only within the already-approved storage root, never any other path. */
async function listTicketDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name !== "pending").map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

export async function investigateMissingNoCorrelationAttachments(opts: { extraPaths: string[]; scanWholeUploadTree: boolean }): Promise<MissingRowReport[]> {
  const ticketAttachments = await prisma.ticketAttachment.findMany({
    select: {
      id: true,
      ticketId: true,
      filename: true,
      originalName: true,
      mimeType: true,
      size: true,
      createdAt: true,
      ticket: { select: { ticketNumber: true, title: true, source: true, createdAt: true, emailMessageId: true } },
    },
  });

  const reports: MissingRowReport[] = [];

  for (const a of ticketAttachments) {
    const row: Row = { kind: "ticket", id: a.id, ownerId: a.ticketId, filename: a.filename, originalName: a.originalName, mimeType: a.mimeType, size: a.size };
    const { privatePath, legacyPath } = storagePaths(row);

    if ((await fileExistsLocally(privatePath)) || (await fileExistsLocally(legacyPath))) continue; // not missing — out of scope
    const emailMessageId = await resolveEmailMessageId(row);
    if (emailMessageId) continue; // has email correlation — out of scope for this investigation (the diagnostic/bulk tools cover it)

    const anyEmailReply = await prisma.ticketMessage.count({ where: { ticketId: a.ticketId, emailMessageId: { not: null } } });

    const originalNameFragment = sanitizedOriginalNameFragment(a.originalName);

    // Canonical directories — each resolved through resolveWithinApprovedRoot
    // before ever being opened, so a symlinked intermediate component can
    // never redirect this search outside UPLOAD_DIR/LEGACY_PUBLIC_UPLOAD_DIR.
    const canonicalDirs: Array<{ dir: string; root: string }> = [
      { dir: path.dirname(privatePath), root: UPLOAD_DIR },
      { dir: path.dirname(legacyPath), root: LEGACY_PUBLIC_UPLOAD_DIR },
    ];
    if (opts.scanWholeUploadTree) {
      for (const d of await listTicketDirs(UPLOAD_DIR)) canonicalDirs.push({ dir: d, root: UPLOAD_DIR });
      for (const d of await listTicketDirs(LEGACY_PUBLIC_UPLOAD_DIR)) canonicalDirs.push({ dir: d, root: LEGACY_PUBLIC_UPLOAD_DIR });
    }

    const searchedLocations = new Set<string>();
    const candidates: CandidateMatch[] = [];

    for (const { dir, root } of canonicalDirs) {
      const safeDir = await resolveWithinApprovedRoot(dir, root);
      if (!safeDir || searchedLocations.has(safeDir)) continue;
      searchedLocations.add(safeDir);
      candidates.push(...(await searchDirectoryForCandidates(safeDir, row, originalNameFragment)));
    }
    // --extra-path directories are the operator's own explicit approval for
    // exactly that path — searched as given, no root to escape-check against.
    for (const extra of opts.extraPaths) {
      if (searchedLocations.has(extra)) continue;
      searchedLocations.add(extra);
      candidates.push(...(await searchDirectoryForCandidates(extra, row, originalNameFragment)));
    }

    reports.push({
      attachmentId: a.id,
      ticketId: a.ticketId,
      ticketNumber: a.ticket.ticketNumber,
      ticketTitle: a.ticket.title,
      ticketSource: a.ticket.source,
      ticketCreatedAt: a.ticket.createdAt.toISOString(),
      ticketHasAnyEmailReply: anyEmailReply > 0,
      filename: a.filename,
      originalName: a.originalName,
      mimeType: a.mimeType,
      size: a.size,
      attachmentCreatedAt: a.createdAt.toISOString(),
      filenameIsSafe: isSafeStoredFilename(a.filename),
      searchedLocations: [...searchedLocations].sort(),
      candidates,
    });
  }

  return reports;
}

function printReport(reports: MissingRowReport[]) {
  console.log(`\n=== ${reports.length} missing, no-email-correlation TicketAttachment row(s) found ===\n`);
  for (const r of reports) {
    console.log(`Ticket #${r.ticketNumber} — "${r.ticketTitle}" (source: ${r.ticketSource}, created ${r.ticketCreatedAt})`);
    console.log(`  Ticket has at least one genuine email reply on record: ${r.ticketHasAnyEmailReply}`);
    console.log(`  Attachment ${r.attachmentId}: originalName=${JSON.stringify(r.originalName)}, mimeType=${r.mimeType}, size=${r.size} bytes, uploaded ${r.attachmentCreatedAt}`);
    console.log(`  Stored filename safe: ${r.filenameIsSafe}`);
    console.log(`  Searched locations (${r.searchedLocations.length}): ${r.searchedLocations.join(", ")}`);
    if (r.candidates.length === 0) {
      console.log(`  No candidate found within the ${r.searchedLocations.length} location(s) listed above — this means "not found there," NOT proof the file is permanently unrecoverable. Other locations (an out-of-band backup, for instance) may still exist and have not been searched here.`);
    } else {
      for (const c of r.candidates) {
        console.log(`  CANDIDATE [${c.classification}] at ${c.location}/${c.foundFilename} (${c.foundSize} bytes)`);
      }
    }
    console.log("");
  }
}

function parseArgs(argv: string[]) {
  const extraPaths = argv.filter((a) => a.startsWith("--extra-path=")).map((a) => a.slice("--extra-path=".length));
  const scanWholeUploadTree = argv.includes("--scan-whole-upload-tree");
  const reportOutArg = argv.find((a) => a.startsWith("--report-out="));
  return { extraPaths, scanWholeUploadTree, reportOut: reportOutArg ? reportOutArg.slice("--report-out=".length) : null };
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

  console.log(`UPLOAD_DIR:               ${path.resolve(UPLOAD_DIR)}`);
  console.log(`LEGACY_PUBLIC_UPLOAD_DIR: ${path.resolve(LEGACY_PUBLIC_UPLOAD_DIR)}`);
  if (args.extraPaths.length > 0) console.log(`Extra search paths:       ${args.extraPaths.join(", ")}`);
  console.log(`Whole-upload-tree scan:   ${args.scanWholeUploadTree ? "ENABLED" : "disabled (default)"}`);

  try {
    const reports = await investigateMissingNoCorrelationAttachments({ extraPaths: args.extraPaths, scanWholeUploadTree: args.scanWholeUploadTree });
    printReport(reports);
    if (args.reportOut) {
      try {
        await fs.writeFile(args.reportOut, JSON.stringify(reports, null, 2));
        console.log(`Structured report written to: ${args.reportOut}`);
      } catch (err) {
        console.log(`\n*** REPORT FILE WRITE FAILED: ${err instanceof Error ? err.message : String(err)} ***`);
        process.exitCode = 1;
      }
    }
    console.log("\nThis script wrote nothing — no DB rows changed, no files copied/moved/deleted, no Graph requests made.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}
