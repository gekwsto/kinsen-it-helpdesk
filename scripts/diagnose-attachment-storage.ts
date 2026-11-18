/**
 * READ-ONLY diagnostic for the Ticket attachment "File not found" investigation.
 *
 * Does exactly three things, none of them destructive:
 *   1. Reads TicketAttachment/PendingTicketAttachment rows from the database
 *      (SELECT only — no INSERT/UPDATE/DELETE anywhere in this file).
 *   2. Calls fs.access() on each row's expected path under BOTH UPLOAD_DIR
 *      (private, current) and LEGACY_PUBLIC_UPLOAD_DIR (old, pre-privacy-fix)
 *      — fs.access never reads file bytes, so attachment CONTENTS are never
 *      touched or logged, only existence.
 *   3. Prints counts, a MIME-type breakdown (the "especially PNG" question),
 *      and the exact ids of affected rows so they can be cross-checked —
 *      never prints file contents, secrets, or env var values.
 *
 * Never writes to the database, never copies/moves/deletes a file, never
 * calls the migration script's --apply mode. Safe to run against production
 * read replicas or the primary — it issues only SELECTs and stat() calls.
 *
 * Usage (run INSIDE the app container so UPLOAD_DIR/cwd match production):
 *   docker exec kinsen-helpdesk npx tsx scripts/diagnose-attachment-storage.ts
 *
 * Or locally against whatever DATABASE_URL/.env this shell has:
 *   npx tsx scripts/diagnose-attachment-storage.ts
 */
import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { UPLOAD_DIR, LEGACY_PUBLIC_UPLOAD_DIR } from "@/lib/attachment-policy";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

type Row = {
  kind: "ticket" | "pending";
  id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  createdAt: Date;
};

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL in this environment — aborting.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  console.log(`UPLOAD_DIR (private, current):      ${path.resolve(UPLOAD_DIR)}`);
  console.log(`LEGACY_PUBLIC_UPLOAD_DIR (old):      ${path.resolve(LEGACY_PUBLIC_UPLOAD_DIR)}`);
  console.log(`process.cwd():                       ${process.cwd()}\n`);

  const ticketAttachments = await prisma.ticketAttachment.findMany({
    select: { id: true, ticketId: true, filename: true, mimeType: true, createdAt: true },
  });
  const pendingAttachments = await prisma.pendingTicketAttachment.findMany({
    select: { id: true, pendingTicketId: true, filename: true, mimeType: true, createdAt: true },
  });

  const rows: Row[] = [
    ...ticketAttachments.map((a) => ({ kind: "ticket" as const, id: a.id, ownerId: a.ticketId, filename: a.filename, mimeType: a.mimeType, createdAt: a.createdAt })),
    ...pendingAttachments.map((a) => ({ kind: "pending" as const, id: a.id, ownerId: a.pendingTicketId, filename: a.filename, mimeType: a.mimeType, createdAt: a.createdAt })),
  ];

  console.log(`Total TicketAttachment rows:         ${ticketAttachments.length}`);
  console.log(`Total PendingTicketAttachment rows:  ${pendingAttachments.length}`);
  console.log(`Total attachment rows:               ${rows.length}\n`);

  type Bucket = "presentPrivate" | "legacyOnly" | "missingBoth";
  const byBucket: Record<Bucket, Row[]> = { presentPrivate: [], legacyOnly: [], missingBoth: [] };
  const mimeBreakdown: Record<string, Record<Bucket, number>> = {};

  for (const row of rows) {
    const privatePath =
      row.kind === "ticket" ? path.join(UPLOAD_DIR, row.ownerId, row.filename) : path.join(UPLOAD_DIR, "pending", row.ownerId, row.filename);
    const legacyPath =
      row.kind === "ticket"
        ? path.join(LEGACY_PUBLIC_UPLOAD_DIR, row.ownerId, row.filename)
        : path.join(LEGACY_PUBLIC_UPLOAD_DIR, "pending", row.ownerId, row.filename);

    const inPrivate = await exists(privatePath);
    const inLegacy = inPrivate ? false : await exists(legacyPath); // only need to check legacy if not already private

    const bucket: Bucket = inPrivate ? "presentPrivate" : inLegacy ? "legacyOnly" : "missingBoth";
    byBucket[bucket].push(row);

    if (!mimeBreakdown[row.mimeType]) mimeBreakdown[row.mimeType] = { presentPrivate: 0, legacyOnly: 0, missingBoth: 0 };
    mimeBreakdown[row.mimeType][bucket]++;
  }

  console.log("=== Summary ===");
  console.log(`Present at UPLOAD_DIR (download works today):      ${byBucket.presentPrivate.length}`);
  console.log(`Only at LEGACY_PUBLIC_UPLOAD_DIR (RECOVERABLE — needs migration): ${byBucket.legacyOnly.length}`);
  console.log(`Missing from BOTH (NOT recoverable from local disk):              ${byBucket.missingBoth.length}\n`);

  console.log("=== By MIME type ===");
  console.log("mimeType".padEnd(40), "present".padStart(8), "legacyOnly".padStart(11), "missingBoth".padStart(12));
  for (const [mime, counts] of Object.entries(mimeBreakdown).sort((a, b) => b[1].legacyOnly + b[1].missingBoth - (a[1].legacyOnly + a[1].missingBoth))) {
    console.log(mime.padEnd(40), String(counts.presentPrivate).padStart(8), String(counts.legacyOnly).padStart(11), String(counts.missingBoth).padStart(12));
  }

  if (byBucket.legacyOnly.length > 0) {
    console.log("\n=== Recoverable (legacy-only) rows — first 50 ===");
    for (const r of byBucket.legacyOnly.slice(0, 50)) {
      console.log(`  ${r.kind} ${r.id} (${r.kind === "ticket" ? "ticketId" : "pendingTicketId"}=${r.ownerId}, mimeType=${r.mimeType}, createdAt=${r.createdAt.toISOString()})`);
    }
    if (byBucket.legacyOnly.length > 50) console.log(`  ...and ${byBucket.legacyOnly.length - 50} more`);
  }

  if (byBucket.missingBoth.length > 0) {
    console.log("\n=== Missing from both locations — first 50 (orphaned rows, not recoverable from local disk) ===");
    for (const r of byBucket.missingBoth.slice(0, 50)) {
      console.log(`  ${r.kind} ${r.id} (${r.kind === "ticket" ? "ticketId" : "pendingTicketId"}=${r.ownerId}, mimeType=${r.mimeType}, createdAt=${r.createdAt.toISOString()})`);
    }
    if (byBucket.missingBoth.length > 50) console.log(`  ...and ${byBucket.missingBoth.length - 50} more`);
  }

  console.log("\nThis script wrote nothing — no DB rows changed, no files copied/moved/deleted.");
  await prisma.$disconnect();
}

main();
