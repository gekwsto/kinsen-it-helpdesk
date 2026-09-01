/**
 * Phase 7 — attachment physical resolution + copy/import.
 *
 * Reuses the CURRENT canonical attachment storage layout (see
 * app/api/tickets/[id]/attachments/route.ts, the live upload endpoint):
 * UPLOAD_DIR/<ticketId>/<filename> on disk, TicketAttachment.path stored as
 * "/uploads/<ticketId>/<filename>". The one deliberate deviation: the live
 * endpoint names files `${Date.now()}-${safeName}` (fine for a one-off live
 * upload); this migration instead uses a name deterministic in the LEGACY
 * record's own id (`legacy-${legacyFileId}-${safeName}`), so a re-run never
 * produces a different on-disk name for the same source record — required
 * for idempotent resume, and Date.now() would defeat that.
 *
 * Every one of the (expected: 143) ticket-linked FileDataTbl rows must
 * resolve to exactly one VERIFIED-to-exist physical file before its bytes
 * are copied — an unresolved/missing physical file is a hard failure for
 * that record (ledger FAILED, reported, never a silently-broken
 * TicketAttachment row pointing nowhere) and the migration must not be
 * reported as a full success while any such failure exists.
 */
import fs from "fs/promises";
import path from "path";
import type { PrismaClient } from "@prisma/client";
import { TicketHistoryType } from "@prisma/client";
import type { LegacyFileDataRow } from "@/lib/services/legacy-migration/sql-source-client";
import type { ResolvedLegacyFile } from "@/lib/services/legacy-migration/attachment-filename-resolver";
import { getLedgerEntry, recordLedgerSuccess, recordLedgerFailure } from "@/lib/services/legacy-migration/ledger";

const EXTENSION_MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".msg": "application/vnd.ms-outlook",
  ".eml": "message/rfc822",
};

/** Safe fallback default per RFC 2046 §4.5.1 for genuinely unknown binary content — never guessed from file content, only ever from the extension. */
const DEFAULT_MIME_TYPE = "application/octet-stream";

export function inferMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? DEFAULT_MIME_TYPE;
}

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Case-insensitive existence check against the actual directory listing —
 * the legacy source is Windows/NTFS (case-insensitive); the migration may
 * run against a copy of the physical files on a case-sensitive filesystem.
 * Returns the ACTUAL on-disk filename (real casing) when found, so the copy
 * step reads the file that genuinely exists rather than trusting the
 * resolver's candidate casing blindly.
 */
async function findActualFileName(dir: string, candidateName: string, dirListingCache: Map<string, string[]>): Promise<string | null> {
  let listing = dirListingCache.get(dir);
  if (!listing) {
    listing = await fs.readdir(dir);
    dirListingCache.set(dir, listing);
  }
  const lowerCandidate = candidateName.toLowerCase();
  return listing.find((f) => f.toLowerCase() === lowerCandidate) ?? null;
}

export interface AttachmentImportContext {
  legacyPhysicalDir: string;
  uploadDir: string;
  ticketIdByLegacyTicketId: Map<number, string>;
  resolvedFilenames: Map<number, ResolvedLegacyFile>;
  /** Resolves FileDataTbl.UploadedBy (legacy UserName) -> target User.id, same map used for ticket requester/assignee resolution. An unresolved/absent UploadedBy leaves TicketAttachment.uploadedById null — reported, never guessed. */
  usernameToUserId: Map<string, string>;
  dryRun: boolean;
}

export interface AttachmentImportOutcome {
  legacyFileId: number;
  status: "created" | "reused" | "failed";
  targetId?: string;
  resolvedPhysicalFileName?: string;
  error?: string;
}

const dirListingCache = new Map<string, string[]>();

/** Only ever call this for a row already known to have Ticket_FileUpload set — the caller filters the full 189-row resolved set down to the (expected: 143) ticket-linked rows AFTER filename resolution has already run over all 189 (see attachment-filename-resolver.ts's header comment). */
export async function importOneLegacyAttachment(db: PrismaClient, row: LegacyFileDataRow, ctx: AttachmentImportContext): Promise<AttachmentImportOutcome> {
  const legacyKey = String(row.Id);

  const existingLedger = await getLedgerEntry(db, "ATTACHMENT", legacyKey);
  if (existingLedger?.status === "SUCCEEDED" && existingLedger.targetId) {
    return { legacyFileId: row.Id, status: "reused", targetId: existingLedger.targetId };
  }

  try {
    if (!row.Ticket_FileUpload) {
      throw new Error(`FileDataTbl ${row.Id}: Ticket_FileUpload is null — not a ticket-linked attachment.`);
    }
    const ticketId = ctx.ticketIdByLegacyTicketId.get(row.Ticket_FileUpload);
    if (!ticketId) {
      throw new Error(`FileDataTbl ${row.Id}: linked ticket ${row.Ticket_FileUpload} was not migrated or not found.`);
    }

    const resolved = ctx.resolvedFilenames.get(row.Id);
    if (!resolved) {
      throw new Error(`FileDataTbl ${row.Id}: no resolved physical filename (resolveLegacyAttachmentFilenames was not run over this record).`);
    }

    const actualOnDiskName = await findActualFileName(ctx.legacyPhysicalDir, resolved.physicalFileName, dirListingCache);
    if (!actualOnDiskName) {
      throw new Error(
        `FileDataTbl ${row.Id}: expected physical file "${resolved.physicalFileName}" (original DB FileName "${row.FileName}") was not found in ${ctx.legacyPhysicalDir}. Hard validation error — refusing to create a broken attachment record.`
      );
    }
    const sourcePath = path.join(ctx.legacyPhysicalDir, actualOnDiskName);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`FileDataTbl ${row.Id}: resolved path "${sourcePath}" exists but is not a regular file.`);
    }

    if (ctx.dryRun) {
      return { legacyFileId: row.Id, status: "created", resolvedPhysicalFileName: actualOnDiskName };
    }

    const targetFileName = `legacy-${row.Id}-${sanitizeFileName(row.FileName)}`;
    const targetTicketDir = path.join(ctx.uploadDir, ticketId);
    await fs.mkdir(targetTicketDir, { recursive: true });
    const targetPath = path.join(targetTicketDir, targetFileName);
    await fs.copyFile(sourcePath, targetPath);
    const copiedStat = await fs.stat(targetPath);

    const uploaderUserName = row.UploadedBy?.trim();
    const uploadedById = uploaderUserName ? ctx.usernameToUserId.get(uploaderUserName) ?? null : null;
    const legacyDescription = row.Description?.trim();

    const attachment = await db.$transaction(async (tx) => {
      const created = await tx.ticketAttachment.create({
        data: {
          ticketId,
          uploadedById,
          filename: targetFileName,
          originalName: row.FileName,
          mimeType: inferMimeType(row.FileName),
          size: copiedStat.size,
          path: `/uploads/${ticketId}/${targetFileName}`,
          createdAt: row.UploadDateTime,
        },
      });
      await tx.ticketHistory.create({
        data: {
          ticketId,
          changedById: uploadedById,
          type: TicketHistoryType.ATTACHMENT_ADDED,
          description: [
            `Legacy attachment "${row.FileName}" migrated (FileDataTbl #${row.Id}).`,
            uploadedById ? null : uploaderUserName ? `Uploader "${uploaderUserName}" unresolved.` : "No uploader recorded in the legacy system.",
            legacyDescription ? `Legacy description: ${legacyDescription}` : null,
          ]
            .filter(Boolean)
            .join(" "),
          newValue: row.FileName,
          createdAt: row.UploadDateTime,
        },
      });
      return created;
    });

    await recordLedgerSuccess(db, "ATTACHMENT", legacyKey, attachment.id);
    return { legacyFileId: row.Id, status: "created", targetId: attachment.id, resolvedPhysicalFileName: actualOnDiskName };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!ctx.dryRun) await recordLedgerFailure(db, "ATTACHMENT", legacyKey, message);
    return { legacyFileId: row.Id, status: "failed", error: message };
  }
}

/**
 * Physical files present in the source directory with NO corresponding
 * resolved FileDataTbl record at all (checked against the FULL 189-record
 * resolution, not just the 143 ticket-linked ones — an unlinked-but-known
 * record is legitimately absent from the target, never an orphan). Reported
 * only, never auto-imported.
 */
export async function findPhysicalOrphans(legacyPhysicalDir: string, allResolvedFilenames: ResolvedLegacyFile[]): Promise<string[]> {
  const knownLower = new Set(allResolvedFilenames.map((r) => r.physicalFileName.toLowerCase()));
  const actualFiles = await fs.readdir(legacyPhysicalDir);
  const orphans = actualFiles.filter((f) => !knownLower.has(f.toLowerCase()));
  dirListingCache.set(legacyPhysicalDir, actualFiles);
  return orphans;
}

export interface SameTicketFilenameCollision {
  legacyTicketId: number;
  fileNameLower: string;
  fileDataIds: number[];
}

/**
 * PREFLIGHT ONLY — reports (never blocks) the (Ticket_FileUpload,
 * lower(FileName)) groups where the SAME legacy ticket has two or more
 * FileDataTbl rows sharing the same case-insensitive display FileName (e.g.
 * "screenshot.png" attached twice to the same ticket). This is a REAL,
 * expected legacy pattern (see attachment-filename-resolver.ts's `.old_N`
 * convention on the legacy PHYSICAL disk), and it is proven safe for the
 * TARGET here: this migration's on-disk target filename is
 * `legacy-${row.Id}-${sanitizeFileName(row.FileName)}` (importOneLegacyAttachment
 * above), and FileDataTbl.Id is a global primary key — so two rows can never
 * produce the same target filename inside UPLOAD_DIR/<ticketId>/, no matter
 * how many times the same display FileName repeats on one ticket. Both rows
 * still import as distinct TicketAttachment records, each preserving its OWN
 * original FileName as `originalName` (the display name users see), and
 * neither can ever overwrite the other's bytes on disk or in the ledger
 * (ledger key is FileDataTbl.Id, also globally unique). See
 * scripts/test-legacy-migration-attachment-resolver.ts for the collision
 * proof.
 */
export function findSameTicketFilenameCollisions(rows: Pick<LegacyFileDataRow, "Id" | "FileName" | "Ticket_FileUpload">[]): SameTicketFilenameCollision[] {
  const groups = new Map<string, { legacyTicketId: number; fileNameLower: string; fileDataIds: number[] }>();
  for (const row of rows) {
    if (row.Ticket_FileUpload == null) continue;
    const fileNameLower = row.FileName.toLowerCase();
    const key = `${row.Ticket_FileUpload}::${fileNameLower}`;
    const group = groups.get(key);
    if (group) group.fileDataIds.push(row.Id);
    else groups.set(key, { legacyTicketId: row.Ticket_FileUpload, fileNameLower, fileDataIds: [row.Id] });
  }
  return [...groups.values()].filter((g) => g.fileDataIds.length > 1);
}
