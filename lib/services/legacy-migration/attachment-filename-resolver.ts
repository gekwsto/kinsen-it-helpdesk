/**
 * Resolves the ACTUAL on-disk physical filename for every
 * security.FileDataTbl row, replicating the legacy system's own duplicate-
 * filename convention: within a case-insensitive filename group (sorted by
 * UploadDateTime ascending, Id as a deterministic tie-breaker), every record
 * except the newest is renamed `base.old_N.ext` (N = 1-indexed position
 * among the older records); the single newest record keeps the plain
 * `base.ext` name. A group of size 1 (no duplicates) always keeps the plain
 * name.
 *
 * CRITICAL (per the migration brief): ALL FileDataTbl rows — including the
 * 46 with Ticket_FileUpload IS NULL — must participate in this ordering,
 * because a NULL-linked row can still occupy an `.old_N` slot ahead of a
 * ticket-linked row in the same filename group. Filtering to ticket-linked
 * rows must only happen AFTER this resolution runs (the caller's job, not
 * this module's — this module intentionally has no concept of
 * "ticket-linked" at all).
 *
 * Each record's OWN `fileName` value (its own casing) is preserved as the
 * base for ITS OWN physical name — this module does not assume every record
 * in a case-insensitive group shares identical on-disk casing (e.g. a group
 * of "DATA.xlsx" + "data.xlsx" is NOT normalized to one shared casing here).
 * The migration runner's Phase 7 is the actual source of truth for whether a
 * candidate resolved name exists on disk — this module only computes the
 * candidate; it never touches the filesystem.
 *
 * Pure, dependency-free, fully unit-testable — see
 * scripts/test-legacy-migration-attachment-resolver.ts.
 */

export interface LegacyFileRecordInput {
  id: number;
  fileName: string;
  uploadDateTime: Date;
}

export interface ResolvedLegacyFile {
  id: number;
  /** The record's own original DB FileName, unmodified — always preserved as TicketAttachment.originalName regardless of the physical resolution below. */
  originalFileName: string;
  /** The resolved physical filename this record's bytes actually live under on disk (e.g. "Capture.old_3.PNG" or, for the newest in its group, "Capture.PNG"). */
  physicalFileName: string;
  /** How many other records share this record's case-insensitive filename (including itself) — 1 means no duplication at all. */
  groupSize: number;
  /** True for the single newest record in its group (the one keeping the plain, un-suffixed name). */
  isNewestInGroup: boolean;
}

/** Splits "Capture 1.PNG" into { base: "Capture 1", ext: ".PNG" } using the LAST dot as the extension boundary. A filename with no dot at all yields an empty extension. */
function splitExtension(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) return { base: fileName, ext: "" };
  return { base: fileName.slice(0, lastDot), ext: fileName.slice(lastDot) };
}

function withOldSuffix(fileName: string, n: number): string {
  const { base, ext } = splitExtension(fileName);
  return `${base}.old_${n}${ext}`;
}

/**
 * Resolves physical filenames for the FULL set of legacy file records
 * (unfiltered — see this module's header comment). Deterministic: the same
 * input array (in any order) always produces the same output, since sorting
 * happens internally per group.
 */
export function resolveLegacyAttachmentFilenames(records: LegacyFileRecordInput[]): ResolvedLegacyFile[] {
  const groups = new Map<string, LegacyFileRecordInput[]>();
  for (const record of records) {
    const key = record.fileName.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }

  const results: ResolvedLegacyFile[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => {
      const dateDiff = a.uploadDateTime.getTime() - b.uploadDateTime.getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.id - b.id; // deterministic tie-breaker
    });

    const newestIndex = sorted.length - 1;
    let oldCounter = 0;
    for (let i = 0; i < sorted.length; i++) {
      const record = sorted[i];
      const isNewest = i === newestIndex;
      const physicalFileName = isNewest ? record.fileName : withOldSuffix(record.fileName, ++oldCounter);
      results.push({
        id: record.id,
        originalFileName: record.fileName,
        physicalFileName,
        groupSize: sorted.length,
        isNewestInGroup: isNewest,
      });
    }
  }

  return results;
}

/** Convenience: the resolver's output as a Map keyed by record id, for O(1) lookup during the actual import loop. */
export function resolveLegacyAttachmentFilenamesById(records: LegacyFileRecordInput[]): Map<number, ResolvedLegacyFile> {
  const resolved = resolveLegacyAttachmentFilenames(records);
  return new Map(resolved.map((r) => [r.id, r]));
}
