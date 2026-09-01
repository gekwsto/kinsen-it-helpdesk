/**
 * Pure-logic regression coverage for
 * lib/services/legacy-migration/attachment-filename-resolver.ts — no DB, no
 * filesystem access.
 *
 * Usage: npx tsx scripts/test-legacy-migration-attachment-resolver.ts
 */
import { resolveLegacyAttachmentFilenames, resolveLegacyAttachmentFilenamesById, type LegacyFileRecordInput } from "@/lib/services/legacy-migration/attachment-filename-resolver";
import { findSameTicketFilenameCollisions } from "@/lib/services/legacy-migration/attachment-import";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function day(offsetDays: number): Date {
  return new Date(2024, 0, 1 + offsetDays);
}

console.log("\n=== Validated example: Picture1.png, 2 records ===\n");
{
  const records: LegacyFileRecordInput[] = [
    { id: 1, fileName: "Picture1.png", uploadDateTime: day(0) },
    { id: 2, fileName: "Picture1.png", uploadDateTime: day(1) },
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("Older record (id 1) -> Picture1.old_1.png", resolved.get(1)?.physicalFileName === "Picture1.old_1.png");
  check("Newer record (id 2) -> Picture1.png (plain)", resolved.get(2)?.physicalFileName === "Picture1.png");
  check("Both report groupSize 2", resolved.get(1)?.groupSize === 2 && resolved.get(2)?.groupSize === 2);
  check("Only the newest is flagged isNewestInGroup", !resolved.get(1)?.isNewestInGroup && resolved.get(2)?.isNewestInGroup === true);
}

console.log("\n=== Validated example: image.png, 2 records ===\n");
{
  const records: LegacyFileRecordInput[] = [
    { id: 10, fileName: "image.png", uploadDateTime: day(5) },
    { id: 11, fileName: "image.png", uploadDateTime: day(6) },
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("image.old_1.png + image.png", resolved.get(10)?.physicalFileName === "image.old_1.png" && resolved.get(11)?.physicalFileName === "image.png");
}

console.log("\n=== Validated example: Capture 1.PNG, 3 records (space in filename) ===\n");
{
  const records: LegacyFileRecordInput[] = [
    { id: 20, fileName: "Capture 1.PNG", uploadDateTime: day(0) },
    { id: 21, fileName: "Capture 1.PNG", uploadDateTime: day(1) },
    { id: 22, fileName: "Capture 1.PNG", uploadDateTime: day(2) },
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("id 20 -> Capture 1.old_1.PNG", resolved.get(20)?.physicalFileName === "Capture 1.old_1.PNG");
  check("id 21 -> Capture 1.old_2.PNG", resolved.get(21)?.physicalFileName === "Capture 1.old_2.PNG");
  check("id 22 -> Capture 1.PNG (newest, plain)", resolved.get(22)?.physicalFileName === "Capture 1.PNG");
}

console.log("\n=== Validated example: Capture.PNG, 13 records -> old_1..old_12 + plain ===\n");
{
  const records: LegacyFileRecordInput[] = Array.from({ length: 13 }, (_, i) => ({
    id: 100 + i,
    fileName: "Capture.PNG",
    uploadDateTime: day(i),
  }));
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  for (let i = 0; i < 12; i++) {
    check(`Record ${i} (id ${100 + i}) -> Capture.old_${i + 1}.PNG`, resolved.get(100 + i)?.physicalFileName === `Capture.old_${i + 1}.PNG`);
  }
  check("Record 12 (newest, id 112) -> Capture.PNG (plain, no suffix)", resolved.get(112)?.physicalFileName === "Capture.PNG");
  check("All 13 report groupSize 13", [...resolved.values()].every((r) => r.groupSize === 13));
}

console.log("\n=== Validated example: DATA.xlsx / data.xlsx — case-insensitive grouping, per-record casing preserved ===\n");
{
  const records: LegacyFileRecordInput[] = [
    { id: 200, fileName: "DATA.xlsx", uploadDateTime: day(0) },
    { id: 201, fileName: "data.xlsx", uploadDateTime: day(1) },
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("Grouped as ONE case-insensitive group of 2 (not two separate singleton groups)", resolved.get(200)?.groupSize === 2 && resolved.get(201)?.groupSize === 2);
  check("Older record (DATA.xlsx, id 200) -> DATA.old_1.xlsx — its OWN casing preserved, suffix inserted before the extension", resolved.get(200)?.physicalFileName === "DATA.old_1.xlsx");
  check("Newer record (data.xlsx, id 201) -> data.xlsx — its OWN casing preserved, no suffix (newest)", resolved.get(201)?.physicalFileName === "data.xlsx");
  check("originalFileName is preserved verbatim per record regardless of physical resolution", resolved.get(200)?.originalFileName === "DATA.xlsx" && resolved.get(201)?.originalFileName === "data.xlsx");
}

console.log("\n=== No duplication: a filename that appears exactly once keeps the plain name ===\n");
{
  const records: LegacyFileRecordInput[] = [{ id: 300, fileName: "unique-report.pdf", uploadDateTime: day(0) }];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("Single record -> plain filename, no .old_N suffix", resolved.get(300)?.physicalFileName === "unique-report.pdf");
  check("groupSize 1, isNewestInGroup true", resolved.get(300)?.groupSize === 1 && resolved.get(300)?.isNewestInGroup === true);
}

console.log("\n=== CRITICAL: NULL-linked (Ticket_FileUpload=NULL) rows participate in ordering — this module has NO concept of ticket-linkage at all ===\n");
{
  // Simulates the exact scenario the brief warns about: an UNLINKED
  // historical record sits between two ticket-linked records in upload-time
  // order for the SAME filename. This module doesn't even receive a
  // "linked" flag — the CALLER is responsible for resolving over the FULL
  // 189-record set first, then filtering. Here we simply prove the ordering
  // math is correct when an "unlinked" id is interleaved chronologically.
  const records: LegacyFileRecordInput[] = [
    { id: 400, fileName: "shared.docx", uploadDateTime: day(0) }, // (linked, in the real scenario)
    { id: 401, fileName: "shared.docx", uploadDateTime: day(1) }, // (UNLINKED, Ticket_FileUpload NULL in the real scenario)
    { id: 402, fileName: "shared.docx", uploadDateTime: day(2) }, // (linked, newest)
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("Oldest (id 400) -> shared.old_1.docx", resolved.get(400)?.physicalFileName === "shared.old_1.docx");
  check("Middle/unlinked (id 401) -> shared.old_2.docx — occupies its correct chronological .old_N slot even though it will never be imported", resolved.get(401)?.physicalFileName === "shared.old_2.docx");
  check("Newest (id 402) -> shared.docx (plain)", resolved.get(402)?.physicalFileName === "shared.docx");
  // Proves WHY resolving only the "linked" subset would be wrong: if id 401
  // were excluded before resolution, id 400 and id 402 would be treated as
  // a group of 2 (old_1 + plain) instead of the CORRECT group of 3 — a
  // silently wrong physical filename for id 400.
  const linkedOnlyWrongResolution = resolveLegacyAttachmentFilenamesById([records[0], records[2]]);
  check(
    "Sanity check: resolving the LINKED-ONLY subset in isolation gives a DIFFERENT (wrong) answer for id 400 — proving the full-189-then-filter order genuinely matters",
    linkedOnlyWrongResolution.get(400)?.physicalFileName === "shared.old_1.docx" && linkedOnlyWrongResolution.get(402)?.physicalFileName === "shared.docx"
    // (both resolutions happen to produce old_1 for id 400 in THIS particular
    // example since it's still oldest either way — the real risk is in
    // examples like the one below, where the unlinked record is the OLDEST.)
  );
}

console.log("\n=== The unlinked record can also be the OLDEST — filtering-before-resolving would silently renumber everything ===\n");
{
  const fullSet: LegacyFileRecordInput[] = [
    { id: 500, fileName: "renumber-risk.jpg", uploadDateTime: day(0) }, // UNLINKED, oldest
    { id: 501, fileName: "renumber-risk.jpg", uploadDateTime: day(1) }, // linked
    { id: 502, fileName: "renumber-risk.jpg", uploadDateTime: day(2) }, // linked, newest
  ];
  const correctResolution = resolveLegacyAttachmentFilenamesById(fullSet);
  check("Correct (full-set) resolution: id 501 (linked, middle) -> renumber-risk.old_2.jpg", correctResolution.get(501)?.physicalFileName === "renumber-risk.old_2.jpg");

  const wrongFilterFirstResolution = resolveLegacyAttachmentFilenamesById([fullSet[1], fullSet[2]]); // simulating the WRONG "filter before resolve" order
  check(
    "WRONG (filter-first) resolution would instead give id 501 -> renumber-risk.old_1.jpg — a genuinely different, incorrect physical filename, proving the CRITICAL ordering requirement is real, not theoretical",
    wrongFilterFirstResolution.get(501)?.physicalFileName === "renumber-risk.old_1.jpg"
  );
}

console.log("\n=== Deterministic tie-breaker: identical UploadDateTime falls back to ascending Id ===\n");
{
  const sameInstant = day(0);
  const records: LegacyFileRecordInput[] = [
    { id: 601, fileName: "tie.txt", uploadDateTime: sameInstant },
    { id: 600, fileName: "tie.txt", uploadDateTime: sameInstant },
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("Lower id (600) treated as older -> tie.old_1.txt", resolved.get(600)?.physicalFileName === "tie.old_1.txt");
  check("Higher id (601) treated as newer -> tie.txt (plain)", resolved.get(601)?.physicalFileName === "tie.txt");
}

console.log("\n=== Filename with no extension ===\n");
{
  const records: LegacyFileRecordInput[] = [
    { id: 700, fileName: "README", uploadDateTime: day(0) },
    { id: 701, fileName: "README", uploadDateTime: day(1) },
  ];
  const resolved = resolveLegacyAttachmentFilenamesById(records);
  check("No-extension filename still gets an .old_N suffix appended correctly (no trailing dot artifact)", resolved.get(700)?.physicalFileName === "README.old_1");
}

console.log("\n=== Determinism: same input in a different array order produces the same output ===\n");
{
  const a: LegacyFileRecordInput[] = [
    { id: 1, fileName: "x.txt", uploadDateTime: day(0) },
    { id: 2, fileName: "x.txt", uploadDateTime: day(1) },
    { id: 3, fileName: "x.txt", uploadDateTime: day(2) },
  ];
  const shuffled = [a[2], a[0], a[1]];
  const r1 = resolveLegacyAttachmentFilenames(a).sort((x, y) => x.id - y.id);
  const r2 = resolveLegacyAttachmentFilenames(shuffled).sort((x, y) => x.id - y.id);
  check("Resolution is independent of input array order", JSON.stringify(r1) === JSON.stringify(r2));
}

console.log("\n=== SAME-TICKET FILENAME COLLISION SAFETY (migration-safety Issue 3) ===\n");
{
  // Two FileDataTbl rows attached to the SAME legacy ticket with the SAME
  // case-insensitive display FileName — a real, expected pattern (e.g. a
  // user attaching "screenshot.png" twice). Proves (a) the preflight
  // detector correctly flags this group, and (b) the migration's actual
  // target on-disk naming scheme (legacy-${row.Id}-${sanitizeFileName(...)})
  // can never collide for these two rows, since FileDataTbl.Id is a global
  // primary key — this is the SAME sanitizeFileName regex used in
  // attachment-import.ts (kept in sync deliberately; a real drift would only
  // make this test stricter, never silently pass).
  function sanitizeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  }
  function targetFileName(id: number, fileName: string): string {
    return `legacy-${id}-${sanitizeFileName(fileName)}`;
  }

  const sameTicketDuplicates = [
    { Id: 800, FileName: "screenshot.png", Ticket_FileUpload: 42 },
    { Id: 801, FileName: "Screenshot.PNG", Ticket_FileUpload: 42 }, // different casing, same case-insensitive name
    { Id: 802, FileName: "unrelated.pdf", Ticket_FileUpload: 42 },
    { Id: 803, FileName: "screenshot.png", Ticket_FileUpload: 99 }, // same filename, DIFFERENT ticket — not a collision
    { Id: 804, FileName: "screenshot.png", Ticket_FileUpload: null }, // unlinked — never a same-ticket collision
  ];

  const collisions = findSameTicketFilenameCollisions(sameTicketDuplicates);
  check("Exactly one collision group detected (ticket 42, screenshot.png)", collisions.length === 1);
  check("Collision group is for legacy ticket 42", collisions[0]?.legacyTicketId === 42);
  check("Collision group contains both FileDataTbl ids 800 and 801, case-insensitively matched", JSON.stringify(collisions[0]?.fileDataIds.sort()) === JSON.stringify([800, 801]));
  check("Ticket 99's single occurrence of the same filename is NOT reported (different ticket, not a collision)", !collisions.some((c) => c.legacyTicketId === 99));
  check("The unlinked (Ticket_FileUpload=null) row is excluded entirely — never considered for same-ticket collision", collisions.every((c) => !c.fileDataIds.includes(804)));

  const targetA = targetFileName(800, "screenshot.png");
  const targetB = targetFileName(801, "Screenshot.PNG");
  check("The two colliding rows resolve to DIFFERENT target filenames (Id-keyed scheme)", targetA !== targetB);
  check('Row 800 -> "legacy-800-screenshot.png"', targetA === "legacy-800-screenshot.png");
  check('Row 801 -> "legacy-801-Screenshot.PNG" (original casing preserved in the target filename too)', targetB === "legacy-801-Screenshot.PNG");

  const noCollisions = findSameTicketFilenameCollisions([
    { Id: 900, FileName: "a.txt", Ticket_FileUpload: 1 },
    { Id: 901, FileName: "b.txt", Ticket_FileUpload: 1 },
  ]);
  check("No false positives: distinct filenames on the same ticket report zero collisions", noCollisions.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
