/**
 * Phase 4.1 (+ Final Import Safety Corrections) — generates/updates the
 * PERSISTENT Historical Import manifest: a committed, stable
 * `externalSourceId` assignment for every source Project row, independent
 * of Ticket ID and Zoho Link (both removed entirely from recognition
 * logic — see this file's own "Manifest identity" section below), and
 * never recomputed from a mutable title or Excel row position alone.
 *
 * ─── Idempotent by design — "do not regenerate identifiers on subsequent
 * runs" ───
 * If the manifest file already exists, every row that matches EXACTLY ONE
 * existing entry's natural key KEEPS that entry's externalSourceId
 * unchanged — this script only ever ADDS new entries for a row that
 * matches NO existing entry, and only when explicitly approved (see
 * below). It never edits or removes an existing entry. Run this again on
 * the exact same source file and the output is byte-for-byte identical
 * (down to the same UUIDs) — verified by a dedicated regression check.
 *
 * ─── Manifest identity (Final Import Safety Corrections) ───
 * The natural key is title + team + expectedStartDate ONLY. Ticket ID is
 * REMOVED entirely — it was never a reliable discriminator (absent on 16
 * of the 20 real source rows) and is itself out of scope for import; using
 * it for row recognition risked a false sense of precision. Zoho Link was
 * never part of the key. The externalSourceId itself remains a random
 * UUID, independent of either field, same as before.
 *
 * ─── Explicit review — never silently assign a new identity ───
 * A source row matching NO existing manifest entry is NOT silently given
 * a new id. It is reported under `reviewRequired` (written to a sibling
 * "<manifest>.review-required.json" file) and excluded from the manifest
 * unless the operator re-runs with `--approve-new`, which assigns a fresh
 * UUID ONLY to rows with ZERO matches (an unambiguous "this is genuinely
 * new" case). A row matching MORE THAN ONE existing entry is ALWAYS
 * reported as ambiguous and is NEVER auto-resolved by any flag — that
 * case requires a human to edit the manifest file directly, since this
 * script has no way to know which existing entry (if any) is correct.
 *
 * Usage:
 *   node --import tsx scripts/historical-import/generate-manifest.ts [--source=<xlsx path>] [--manifest=<json path>] [--approve-new]
 *
 * All arguments are optional; sensible defaults point at the known source
 * file location and the committed manifest for the first production
 * import batch. Pass different paths to generate a manifest for a
 * different export with NO code change.
 *
 * STRICTLY READ-ONLY against the application database — this script never
 * imports Prisma at all. It only reads the source .xlsx and writes the
 * manifest JSON (+ its review-required sibling, when applicable).
 */
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { readProjectListRows, type SourceRow } from "./read-source-rows";
import type { Manifest, ManifestEntry } from "./manifest";

const DEFAULT_SOURCE_XLSX = "/Users/pavloschatzisavvas/Downloads/ProjectList_ 23-11-2026 (15 10).xlsx";
const DEFAULT_MANIFEST_JSON = path.join(__dirname, "manifests", "project-list-2026-11-23.json");

function parseArgs() {
  const args = process.argv.slice(2);
  const source = args.find((a) => a.startsWith("--source="))?.slice("--source=".length) ?? DEFAULT_SOURCE_XLSX;
  const manifestPath = args.find((a) => a.startsWith("--manifest="))?.slice("--manifest=".length) ?? DEFAULT_MANIFEST_JSON;
  const approveNew = args.includes("--approve-new");
  return { source, manifestPath, approveNew };
}

function naturalKeyOf(row: SourceRow): ManifestEntry["naturalKey"] {
  return { title: row.title, team: row.team, expectedStartDate: row.expectedStartDate };
}

function naturalKeysMatch(a: ManifestEntry["naturalKey"], b: ManifestEntry["naturalKey"]): boolean {
  return a.title === b.title && a.team === b.team && a.expectedStartDate === b.expectedStartDate;
}

async function main() {
  const { source: sourcePath, manifestPath, approveNew } = parseArgs();
  const reviewRequiredPath = manifestPath.replace(/\.json$/, "") + ".review-required.json";

  const rows = await readProjectListRows(sourcePath);

  let existing: Manifest | null = null;
  try {
    existing = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    existing = null; // no manifest yet — every row below is new.
  }

  // Entries are carried over VERBATIM (ids untouched) — only the stored
  // naturalKey shape is narrowed to {title, team, expectedStartDate},
  // dropping a legacy `ticketId` key a manifest written by an OLDER
  // version of this script may still have on disk (see this file's own
  // "Manifest identity" doc comment).
  const entries: ManifestEntry[] = existing
    ? existing.entries.map((e) => ({
        externalSourceId: e.externalSourceId,
        naturalKey: { title: e.naturalKey.title, team: e.naturalKey.team, expectedStartDate: e.naturalKey.expectedStartDate },
      }))
    : [];

  let kept = 0;
  let newlyAssigned = 0;
  const reviewRequired: { reason: "NO_MATCH" | "AMBIGUOUS_MULTIPLE_MATCHES"; naturalKey: ManifestEntry["naturalKey"]; candidateExternalSourceIds: string[] }[] = [];

  for (const row of rows) {
    const key = naturalKeyOf(row);
    const matches = entries.filter((e) => naturalKeysMatch(e.naturalKey, key));

    if (matches.length === 1) {
      kept++;
      continue; // NEVER regenerate — the existing id stands, untouched.
    }

    if (matches.length > 1) {
      // ALWAYS requires manual resolution — no flag ever auto-resolves
      // this, since the script cannot tell which (if any) is correct.
      reviewRequired.push({ reason: "AMBIGUOUS_MULTIPLE_MATCHES", naturalKey: key, candidateExternalSourceIds: matches.map((m) => m.externalSourceId) });
      continue;
    }

    // Zero matches — genuinely unmatched. Never silently assigned.
    if (approveNew) {
      entries.push({ externalSourceId: `historical-import:project-list:${crypto.randomUUID()}`, naturalKey: key });
      newlyAssigned++;
    } else {
      reviewRequired.push({ reason: "NO_MATCH", naturalKey: key, candidateExternalSourceIds: [] });
    }
  }

  const manifest: Manifest = {
    sourceFile: path.basename(sourcePath),
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
    note:
      "Stable externalSourceId assignments for each source Project row — generated ONCE by scripts/historical-import/generate-manifest.ts and never regenerated for a row already matched here. The natural key is title + team + expectedStartDate ONLY — Ticket ID and Zoho Link are REMOVED entirely from recognition logic (both out of scope for import — see Phase 4.1's own 'Explicit exclusions'). A row matching no existing entry, or more than one, is NEVER silently assigned/kept — see this script's own 'reviewRequired' output and its --approve-new flag.",
    entries,
  };

  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  if (reviewRequired.length > 0) {
    await fs.writeFile(reviewRequiredPath, JSON.stringify({ generatedAt: new Date().toISOString(), reviewRequired }, null, 2) + "\n", "utf8");
  } else {
    await fs.rm(reviewRequiredPath, { force: true });
  }

  console.log(`Manifest written to ${manifestPath}`);
  console.log(`${rows.length} source rows processed — ${kept} kept their existing id, ${newlyAssigned} newly assigned, ${reviewRequired.length} require explicit review.`);
  if (reviewRequired.length > 0) {
    console.log(`Review-required rows written to ${reviewRequiredPath} — resolve manually (ambiguous matches) or re-run with --approve-new (unambiguous new rows only).`);
  }
}

main().catch((err) => {
  console.error("Manifest generation failed:", err);
  process.exit(1);
});
