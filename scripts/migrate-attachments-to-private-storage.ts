/**
 * Copies existing Ticket/PendingTicket attachment files from the OLD,
 * publicly-servable location (LEGACY_PUBLIC_UPLOAD_DIR = "./public/uploads")
 * to the NEW private location (UPLOAD_DIR — see lib/attachment-policy.ts,
 * defaults to "./storage/uploads") so attachments uploaded/ingested before
 * this fix keep working through the authenticated download route
 * (GET /api/tickets/[id]/attachments/[attachmentId]), which reads only from
 * UPLOAD_DIR and has no knowledge of the old location.
 *
 * For the project's own docker-compose.yml deployment specifically, this
 * script is NOT required: the compose file's host-side upload volume
 * (./uploads) is unchanged, only its container-side mount point moved (from
 * /app/public/uploads to /app/storage/uploads) — see docker-compose.yml's
 * own comment. Every file already on that host volume is already visible at
 * the new UPLOAD_DIR path the moment the container restarts with the
 * updated compose file, with nothing to copy. This script exists for every
 * OTHER deployment shape: a bare `next start` / non-Docker host, or any
 * setup where attachments were written directly under public/uploads on the
 * filesystem the app process itself sees (not through the compose
 * indirection) — there, UPLOAD_DIR's new default genuinely points somewhere
 * that does not yet contain the old files, and this script is what carries
 * them forward.
 *
 * runMigration() below is exported (in addition to being runnable as a CLI
 * script) specifically so scripts/test-pending-ticket-email-ingestion.ts can
 * exercise the exact same logic this file's `main()` runs against synthetic
 * fixtures — one implementation, both a real operator tool and a regression
 * test, never two copies that could drift.
 *
 * SAFETY
 *   - --dry-run is the DEFAULT (also true with no flags at all) — reports
 *     what would be copied, touches nothing.
 *   - --apply is required to actually write anything.
 *   - COPY only, never move/delete: every existing source file is left
 *     exactly where it is, in both modes, forever — nothing is ever
 *     orphaned by this script even if it's never re-run.
 *   - Idempotent: a destination file that already exists (matching size) is
 *     left alone and reported as "already migrated," not re-copied.
 *   - Verifies every copy is byte-for-byte identical to its source before
 *     considering it successful.
 *   - Never invoked automatically by the app itself (not part of startup,
 *     a migration, or a request handler) — purely an operator-run tool.
 *
 * Usage:
 *   npx tsx scripts/migrate-attachments-to-private-storage.ts            # dry run (default)
 *   npx tsx scripts/migrate-attachments-to-private-storage.ts --dry-run  # same, explicit
 *   npx tsx scripts/migrate-attachments-to-private-storage.ts --apply    # actually copies
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR } from "@/lib/attachment-policy";

interface PlanRow {
  kind: "ticket" | "pending";
  id: string;
  ownerId: string; // ticketId or pendingTicketId
  filename: string;
  sourcePath: string;
  destPath: string;
}

export interface MigrationStats {
  totalTicketAttachmentRows: number;
  totalPendingAttachmentRows: number;
  alreadyPrivate: number;
  alreadyMigrated: number;
  missingSource: number;
  toCopy: number;
  copied: number;
  verifiedIdentical: number;
  failed: number;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Runs the plan-and-copy pass once against whatever TicketAttachment/
 * PendingTicketAttachment rows currently exist in the database, using the
 * given `db` client (a plain PrismaClient in normal use; a test can pass
 * the same shared `prisma` import — no transaction isolation is needed
 * here, this only ever reads rows and touches the filesystem). Does NOT
 * connect/disconnect prisma or call process.exit — callers (this file's own
 * CLI `main()`, or a test) own that.
 */
export async function runMigration(
  db: Pick<typeof prisma, "ticketAttachment" | "pendingTicketAttachment">,
  opts: { apply: boolean; log?: (...args: unknown[]) => void }
): Promise<MigrationStats> {
  const log = opts.log ?? (() => {});
  const plan: PlanRow[] = [];

  const ticketAttachments = await db.ticketAttachment.findMany({ select: { id: true, ticketId: true, filename: true } });
  for (const a of ticketAttachments) {
    plan.push({
      kind: "ticket",
      id: a.id,
      ownerId: a.ticketId,
      filename: a.filename,
      sourcePath: path.join(LEGACY_PUBLIC_UPLOAD_DIR, a.ticketId, a.filename),
      destPath: path.join(UPLOAD_DIR, a.ticketId, a.filename),
    });
  }

  const pendingAttachments = await db.pendingTicketAttachment.findMany({ select: { id: true, pendingTicketId: true, filename: true } });
  for (const a of pendingAttachments) {
    plan.push({
      kind: "pending",
      id: a.id,
      ownerId: a.pendingTicketId,
      filename: a.filename,
      sourcePath: path.join(LEGACY_PUBLIC_UPLOAD_DIR, "pending", a.pendingTicketId, a.filename),
      destPath: path.join(UPLOAD_DIR, "pending", a.pendingTicketId, a.filename),
    });
  }

  log(`Found ${ticketAttachments.length} TicketAttachment row(s) and ${pendingAttachments.length} PendingTicketAttachment row(s) in the database.\n`);

  const stats: MigrationStats = {
    totalTicketAttachmentRows: ticketAttachments.length,
    totalPendingAttachmentRows: pendingAttachments.length,
    alreadyPrivate: 0,
    alreadyMigrated: 0,
    missingSource: 0,
    toCopy: 0,
    copied: 0,
    verifiedIdentical: 0,
    failed: 0,
  };

  for (const row of plan) {
    const destExists = await fileExists(row.destPath);
    const sourceExists = await fileExists(row.sourcePath);

    if (destExists) {
      stats.alreadyPrivate++;
      if (sourceExists) stats.alreadyMigrated++;
      continue;
    }

    if (!sourceExists) {
      stats.missingSource++;
      log(`  ⚠ ${row.kind} attachment ${row.id} (${row.ownerId}/${row.filename}) — neither legacy nor private copy found on disk. Row is orphaned; this does not create/repair file content.`);
      continue;
    }

    stats.toCopy++;
    log(`  → ${row.kind} attachment ${row.id}: ${row.sourcePath} -> ${row.destPath}`);

    if (!opts.apply) continue;

    try {
      await fs.mkdir(path.dirname(row.destPath), { recursive: true });
      await fs.copyFile(row.sourcePath, row.destPath);
      stats.copied++;

      const [srcHash, destHash] = await Promise.all([sha256(row.sourcePath), sha256(row.destPath)]);
      if (srcHash === destHash) {
        stats.verifiedIdentical++;
      } else {
        stats.failed++;
        log(`  ✗ Byte mismatch after copy for ${row.destPath} — removing the bad copy, source is untouched.`);
        await fs.rm(row.destPath, { force: true }).catch(() => {});
      }
    } catch (err) {
      stats.failed++;
      log(`  ✗ Failed to copy ${row.sourcePath}:`, err instanceof Error ? err.message : err);
    }
  }

  return stats;
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

  console.log(`\n=== Attachment private-storage migration — ${mode} ===`);
  console.log(`Source (legacy, public):  ${path.resolve(LEGACY_PUBLIC_UPLOAD_DIR)}`);
  console.log(`Destination (private):    ${path.resolve(UPLOAD_DIR)}\n`);

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  const stats = await runMigration(prisma, { apply, log: (...a) => console.log(...a) });

  console.log(`\n=== Summary (${mode}) ===`);
  console.log(`Already private (destination exists):        ${stats.alreadyPrivate} (of which source also still present: ${stats.alreadyMigrated})`);
  console.log(`Missing at BOTH locations (orphaned rows):    ${stats.missingSource}`);
  console.log(`${apply ? "Copied" : "Would copy"}:                                  ${stats.toCopy}`);
  if (apply) {
    console.log(`  ...verified byte-identical:                 ${stats.verifiedIdentical}`);
    console.log(`  ...failed (source left untouched):          ${stats.failed}`);
  }
  console.log(
    apply
      ? "\nDone. Source files under the legacy location were never modified or deleted."
      : "\nThis was a dry run — nothing was written. Re-run with --apply to perform the copy."
  );

  await prisma.$disconnect();
  process.exit(stats.failed > 0 ? 1 : 0);
}

// Only run the CLI when this file is executed directly (`npx tsx
// scripts/migrate-attachments-to-private-storage.ts`), not when
// runMigration is imported by the test suite.
if (require.main === module) {
  main();
}
