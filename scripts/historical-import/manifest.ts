/**
 * Phase 4.1 — loads the persistent manifest written by
 * generate-manifest.ts and matches source rows to their stable
 * externalSourceId by natural key. Read-only — never writes/regenerates
 * anything (see generate-manifest.ts for the one place that does).
 *
 * ─── Final Import Safety Corrections ───
 * The natural key is title + team + expectedStartDate ONLY — Ticket ID
 * (and Zoho Link, which was never part of it) is REMOVED entirely from
 * recognition logic, per this feature's own "Manifest identity" spec:
 * identity must never depend on a field that's absent for 16 of the 20
 * real source rows and is itself out of scope for import. A manifest file
 * written by an OLDER version of generate-manifest.ts may still have a
 * `ticketId` key inside a stored `naturalKey` on disk — ignored here on
 * read (TypeScript's structural typing simply doesn't surface it), and
 * stripped for good the next time generate-manifest.ts rewrites the file.
 */
import fs from "fs/promises";
import type { SourceRow } from "./read-source-rows";

export interface ManifestEntry {
  externalSourceId: string;
  naturalKey: {
    title: string;
    team: string | null;
    expectedStartDate: string | null;
  };
}

export interface Manifest {
  sourceFile: string;
  generatedAt: string;
  note: string;
  entries: ManifestEntry[];
}

export async function loadManifest(manifestPath: string): Promise<Manifest> {
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

/**
 * Null when the row has no matching manifest entry — e.g. a NEW row added
 * to the source file since the manifest was last generated. Callers must
 * treat this as a STRUCTURAL blocker (run generate-manifest.ts first),
 * never assign an ad hoc id inline.
 */
/**
 * Returns every entry whose natural key matches this row — NOT just the
 * first — so a caller can distinguish "exactly one match" (safe to use)
 * from "more than one" (ambiguous, must never be auto-resolved; see
 * generate-manifest.ts's own "explicit review" rule).
 */
export function findManifestEntries(manifest: Manifest, row: SourceRow): ManifestEntry[] {
  return manifest.entries.filter((e) => e.naturalKey.title === row.title && e.naturalKey.team === row.team && e.naturalKey.expectedStartDate === row.expectedStartDate);
}

/** Convenience for callers (e.g. the dry-run tool) that only care about the unambiguous case. */
export function findManifestEntry(manifest: Manifest, row: SourceRow): ManifestEntry | null {
  const matches = findManifestEntries(manifest, row);
  return matches.length === 1 ? matches[0] : null;
}
