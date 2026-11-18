/**
 * Focused regression for the attachment-matching logic in
 * scripts/diagnose-attachment-graph-recovery.ts, covering two rounds of
 * fixes to the same underlying script:
 *
 * ROUND 1 (metadata vs. byte availability) — the root cause of a real
 * production run reporting 0 graph_recoverable despite 3 source emails
 * being found successfully: the original single filter
 * (`name === X && size === Y && !!contentBytes`) could not distinguish
 * "no attachment matches at all" from "found a unique metadata match, but
 * Graph didn't include contentBytes for it" (true by design for any
 * itemAttachment/referenceAttachment, and possible even for a
 * fileAttachment in a given response).
 *
 * ROUND 2 (collection presence + name/size split) — after round 1 shipped,
 * a second real production run showed EVERY affected row still landing in
 * the single "zero metadata matches" bucket, across only 3 messages — too
 * uniform to be independent name/size coincidences. The suspected cause
 * (a documented Graph quirk where `$filter` + `$expand=attachments` on the
 * messages LIST endpoint can return no attachments collection at all) can
 * only be confirmed by distinguishing "no collection," "empty collection,"
 * and "name mismatch" as separate outcomes instead of one combined
 * `(message.attachments ?? []).filter(...)` catch-all.
 *
 * ROUND 3 (Graph metadata size reliability) — a third real production run
 * against 206 real rows found exactly 10 with a unique originalName match
 * (3 messages, no missing collections, no name mismatches, no request
 * errors) that ALL failed solely because Graph's reported attachment
 * `size` differed from the row's own DB size. Since Graph's `size` is
 * documented only as "the size in bytes of the attachment" with no stated
 * guarantee it equals `Buffer.from(contentBytes, "base64").length` (and a
 * documented third-party report shows exactly this kind of gap), a size
 * mismatch is no longer a dead end: name becomes the SOLE uniqueness gate
 * (size is never used to disambiguate — it isn't trustworthy enough for
 * that), and once a unique name match is found with a disagreeing size,
 * the decoded contentBytes is compared against the row's OWN DB size
 * (never Graph's) to resolve it.
 *
 * ROUND 4 (strict base64 validation + zero-byte attachments) — final
 * correctness pass before shipping round 3: `Buffer.from(str, "base64")`
 * is lenient (it silently drops characters outside the base64 alphabet
 * instead of rejecting malformed input), so a genuinely malformed value
 * could previously decode into a plausible-but-wrong byte sequence and
 * only ever surface as an opaque length mismatch, never as "malformed."
 * Fixed by validating the string against a strict base64 pattern BEFORE
 * ever decoding it (checkContentBytes's new isStrictlyValidBase64 check).
 * Separately, a legitimately empty attachment (DB size 0) is correctly
 * base64-encoded as `""` — valid, zero-length content — but the previous
 * check (`decoded.length > 0 && decoded.length === expectedSize`) would
 * have wrongly rejected it, since 0 > 0 is false; a real 0-byte file
 * could never have been classified recoverable. Fixed by only treating a
 * MISSING field (`undefined`/`null`) as absent, never an explicit `""`.
 * Also softened the "recoverable" wording throughout (both plain
 * graph_recoverable and graph_recoverable_metadata_size_mismatch): a
 * decoded-length match is a RECOVERY CANDIDATE, never asserted as proof
 * of byte-for-byte identity with the original historical content (this
 * script has no hash or other content signature to verify that).
 *
 * ROUND 5 (dry-run inventory + cross-mailbox-safe distinct counting) —
 * added the `--dry-run` flag (covered by its own dedicated test script,
 * scripts/test-attachment-graph-recovery-dry-run.ts) and a distinct
 * Graph-source-attachment count alongside each classification's row
 * count. That dedup key is `${mailbox}::${emailMessageId}::${match.id}`,
 * NEVER the bare Graph attachment id alone — Graph only documents
 * attachment ids as unique within the message/mailbox they came from,
 * never guaranteed unique across different mailboxes, so deduping on the
 * bare id could theoretically undercount distinct source attachments if
 * two different mailboxes ever produced the same id string. Scenarios 15
 * and 16 below prove this directly: two different mailboxes, two
 * different messages, identical bare attachment id — must count as 2
 * distinct sources, not 1.
 *
 * Covers, via a mocked microsoftGraph client (no real network/credentials
 * needed, same mock.module pattern used throughout this codebase's other
 * focused test scripts):
 *   - Unique name+size match + contentBytes present -> graph_recoverable
 *     (unchanged happy path).
 *   - Unique name+size match + contentBytes ABSENT + @odata.type IS
 *     fileAttachment -> graph_metadata_matched_bytes_unavailable (the
 *     exact round-1 production scenario).
 *   - Unique name+size match + contentBytes ABSENT + @odata.type is
 *     itemAttachment -> graph_metadata_matched_not_file_type.
 *   - Unique name+size match, contentBytes present but NOT well-formed
 *     base64 (contains characters outside the base64 alphabet) ->
 *     graph_metadata_matched_bytes_unavailable with a "malformed" reason
 *     (the round-4 strict-validation fix).
 *   - Unique name+size match, BOTH size 0, contentBytes `""` ->
 *     graph_recoverable (the round-4 zero-byte fix — previously
 *     impossible to classify as recoverable).
 *   - `message.attachments` is `undefined` -> graph_no_attachment_collection
 *     (the round-2 suspected root cause).
 *   - `message.attachments` is `[]` -> graph_empty_attachment_collection.
 *   - Attachments present, none share the row's originalName ->
 *     graph_attachment_name_mismatch.
 *   - 2+ attachments share the SAME name (size irrelevant) ->
 *     graph_attachment_ambiguous.
 *   - Unique name match, Graph size disagrees with DB size, but decoded
 *     contentBytes length matches the DB size exactly ->
 *     graph_recoverable_metadata_size_mismatch (the round-3 production
 *     scenario — a recovery candidate despite the metadata disagreement).
 *   - Unique name match, Graph size disagrees, contentBytes absent ->
 *     graph_metadata_size_mismatch_bytes_unavailable.
 *   - Unique name match, Graph size disagrees, contentBytes present but
 *     NOT well-formed base64 -> graph_metadata_size_mismatch_malformed_base64.
 *   - Unique name match, Graph size disagrees, decoded length matches
 *     NEITHER the DB size nor Graph's size ->
 *     graph_metadata_size_mismatch_bytes_differ.
 *   - Request-level failures (429/403) still classified as
 *     graph_request_failed, never conflated with "not found" (regression
 *     guard for an earlier fix, re-verified here too).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-attachment-graph-recovery-matching.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { Role, AuthProvider, TicketSource } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const TAG = `gmatch-${RUN_ID}`;

// ── One fixture per scenario, each its own ticket (own emailMessageId) so
//    each triggers its own independent mocked Graph response. ──
const SCENARIOS = [
  { msgId: `<${TAG}-recoverable@example.com>`, originalName: "a.png", size: 100 },
  { msgId: `<${TAG}-bytes-unavailable@example.com>`, originalName: "b.png", size: 200 },
  { msgId: `<${TAG}-not-file-type@example.com>`, originalName: "c.png", size: 300 },
  { msgId: `<${TAG}-name-mismatch@example.com>`, originalName: "d.png", size: 400 },
  { msgId: `<${TAG}-collision@example.com>`, originalName: "e.png", size: 500 },
  { msgId: `<${TAG}-invalid-bytes@example.com>`, originalName: "f.png", size: 600 },
  { msgId: `<${TAG}-no-collection@example.com>`, originalName: "g.png", size: 700 },
  { msgId: `<${TAG}-empty-collection@example.com>`, originalName: "h.png", size: 800 },
  { msgId: `<${TAG}-metasize-bytes-differ@example.com>`, originalName: "i.png", size: 900 },
  { msgId: `<${TAG}-metasize-recoverable@example.com>`, originalName: "j.png", size: 100 },
  { msgId: `<${TAG}-metasize-bytes-unavailable@example.com>`, originalName: "k.png", size: 950 },
  { msgId: `<${TAG}-metasize-invalid-base64@example.com>`, originalName: "l.png", size: 960 },
  { msgId: `<${TAG}-zero-byte-valid@example.com>`, originalName: "m.png", size: 0 },
  { msgId: `<${TAG}-malformed-base64-straightforward@example.com>`, originalName: "n.png", size: 50 },
  // Cross-mailbox collision pair: two DIFFERENT mailboxes, two DIFFERENT
  // messages, but the mocked Graph response for each reports the exact
  // SAME bare attachment id ("att-collision-id"). Graph only documents an
  // attachment id as unique within the message/mailbox it came from, so
  // this must count as 2 distinct source attachments, never 1 — proving
  // the dedup key is ${mailbox}::${emailMessageId}::${id}, not the bare id.
  { msgId: `<${TAG}-cross-mailbox-a@example.com>`, originalName: "o.png", size: 100, mailbox: `${TAG}-mbA@example.com` },
  { msgId: `<${TAG}-cross-mailbox-b@example.com>`, originalName: "o.png", size: 100, mailbox: `${TAG}-mbB@example.com` },
];

// Real base64 that decodes to EXACTLY 100 bytes — checkContentBytes
// requires an exact decoded-length match against the row's own size, not
// merely a non-empty string, so the "recoverable" fixtures must actually
// satisfy that.
const VALID_100_BYTE_CONTENT = Buffer.from("x".repeat(100)).toString("base64");
// Valid, well-formed base64 that decodes to far fewer bytes than the
// row's expected size (600) — simulates a truncated/corrupted response
// that is nonetheless NOT malformed base64 (confirmed:
// Buffer.from("short").toString("base64") -> "c2hvcnQ=", which passes
// strict base64 validation and decodes to exactly 5 bytes).
const TRUNCATED_CONTENT = Buffer.from("short").toString("base64");
// No valid base64 characters at all — fails strict base64 validation
// outright (confirmed against the real STRICT_BASE64_RE pattern), so
// this is now "malformed," never silently decoded into a 0-length value.
const GARBAGE_BASE64 = "!!!!";
// Contains characters ('@') entirely outside the base64 alphabet, at a
// length Buffer.from would otherwise happily (and wrongly) decode from —
// the exact case strict validation exists to catch in the straightforward
// (size-matches) path too, not just the metadata-size-mismatch path.
const MALFORMED_BASE64_WITH_VALID_CHARS = "not@@base64!!";

mock.module("@/lib/microsoft-graph", {
  namedExports: {
    GraphConfigurationError: class GraphConfigurationError extends Error {},
    microsoftGraph: {
      getMessageByInternetMessageId: async (_mailbox: string, emailMessageId: string) => {
        if (emailMessageId === SCENARIOS[0].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-1", name: "a.png", size: 100, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] };
        }
        if (emailMessageId === SCENARIOS[1].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-2", name: "b.png", size: 200, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // no contentBytes — the exact production scenario
        }
        if (emailMessageId === SCENARIOS[2].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-3", name: "c.png", size: 300, "@odata.type": "#microsoft.graph.itemAttachment" }] }; // no contentBytes, not a file type
        }
        if (emailMessageId === SCENARIOS[3].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-4", name: "other.png", size: 999, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // no attachment shares this row's originalName at all
        }
        if (emailMessageId === SCENARIOS[4].msgId) {
          return {
            internetMessageId: emailMessageId,
            attachments: [
              { id: "att-5a", name: "e.png", size: 500, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" },
              { id: "att-5b", name: "e.png", size: 500, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" },
            ],
          }; // two attachments with the SAME name+size — collision
        }
        if (emailMessageId === SCENARIOS[5].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-6", name: "f.png", size: 600, contentBytes: TRUNCATED_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // present but truncated/corrupt — must NOT be trusted as recoverable
        }
        if (emailMessageId === SCENARIOS[6].msgId) {
          return { internetMessageId: emailMessageId, hasAttachments: true }; // no "attachments" field in the response at all — the suspected $expand-on-filtered-list Graph quirk
        }
        if (emailMessageId === SCENARIOS[7].msgId) {
          return { internetMessageId: emailMessageId, hasAttachments: true, attachments: [] }; // present but empty
        }
        if (emailMessageId === SCENARIOS[8].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-9", name: "i.png", size: 111, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // name matches, Graph size (111) disagrees with DB size (900), AND decoded length (100) matches neither — genuinely unresolvable
        }
        if (emailMessageId === SCENARIOS[9].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-10", name: "j.png", size: 150, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // name matches, Graph size (150) disagrees with DB size (100), but decoded length (100) matches the DB size exactly — recoverable despite the metadata disagreement
        }
        if (emailMessageId === SCENARIOS[10].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-11", name: "k.png", size: 123, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // name matches, Graph size (123) disagrees with DB size (950), contentBytes absent — unresolvable this run
        }
        if (emailMessageId === SCENARIOS[11].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-12", name: "l.png", size: 123, contentBytes: GARBAGE_BASE64, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // name matches, Graph size (123) disagrees with DB size (960), contentBytes present but NOT well-formed base64
        }
        if (emailMessageId === SCENARIOS[12].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-13", name: "m.png", size: 0, contentBytes: "", "@odata.type": "#microsoft.graph.fileAttachment" }] }; // straightforward path: Graph size (0) == DB size (0), contentBytes is the legitimate zero-byte encoding — must be recoverable, not "absent"
        }
        if (emailMessageId === SCENARIOS[13].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-14", name: "n.png", size: 50, contentBytes: MALFORMED_BASE64_WITH_VALID_CHARS, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // straightforward path: Graph size (50) == DB size (50), but contentBytes is malformed — must NOT be silently decoded into a wrong-but-plausible value
        }
        if (emailMessageId === SCENARIOS[14].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-collision-id", name: "o.png", size: 100, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // mailbox A — recoverable, bare id deliberately collides with scenario 16
        }
        if (emailMessageId === SCENARIOS[15].msgId) {
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-collision-id", name: "o.png", size: 100, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // mailbox B — recoverable, bare id deliberately collides with scenario 15 but is a DIFFERENT real attachment (different mailbox/message)
        }
        throw new Error(`Unexpected mocked lookup for ${emailMessageId}`);
      },
    },
  },
});

async function main() {
  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];
  const attachmentIds: string[] = [];
  const logIds: string[] = [];

  try {
    const dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
    const user = await prisma.user.create({ data: { email: `${TAG}-user@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    userIds.push(user.id);

    const expectedRowKeyToClassification: Record<string, string> = {};
    for (const s of SCENARIOS) {
      const ticket = await prisma.ticket.create({
        data: { title: `${TAG} ticket`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id, emailMessageId: s.msgId },
      });
      ticketIds.push(ticket.id);
      const attachment = await prisma.ticketAttachment.create({
        data: { ticketId: ticket.id, uploadedById: user.id, filename: `${TAG}-missing-${ticket.id}.bin`, originalName: s.originalName, mimeType: "image/png", size: s.size, path: "/x" },
      });
      attachmentIds.push(attachment.id);
      const log = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: s.msgId, action: "CREATED_TICKET", mailbox: s.mailbox ?? `${TAG}-mb@example.com` } });
      logIds.push(log.id);
      expectedRowKeyToClassification[`ticket:${attachment.id}`] = "";
    }

    // Capture console output from the diagnostic script to assert on.
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      lines.push(line);
      originalLog(...args);
    };

    try {
      await import("@/scripts/diagnose-attachment-graph-recovery");
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      console.log = originalLog;
    }

    const output = lines.join("\n");

    check("Scenario 1 (contentBytes present, exact-length-verified) -> graph_recoverable", output.includes("att-1") && output.includes("[graph_recoverable]"));
    check("Scenario 1 detail uses 'recovery candidate' wording, not a byte-for-byte identity claim", output.includes("recovery candidate") && output.includes("not proof of byte-for-byte identity"));
    check("Scenario 2 (unique match, bytes absent, fileAttachment) -> graph_metadata_matched_bytes_unavailable", output.includes("att-2") && output.includes("contentBytes was absent"));
    check("Scenario 3 (unique match, bytes absent, itemAttachment) -> graph_metadata_matched_not_file_type", output.includes("graph_metadata_matched_not_file_type"));
    check("Scenario 3 detail mentions itemAttachment", output.includes("itemAttachment"));
    check("Scenario 4 (no attachment shares the name) -> graph_attachment_name_mismatch", /graph_attachment_name_mismatch\s+1/.test(output));
    check("Scenario 5 (2 attachments match name+size) -> graph_attachment_ambiguous", /graph_attachment_ambiguous\s+1/.test(output) && !/graph_attachment_ambiguous_or_missing/.test(output));
    const att6Line = lines.find((l) => l.includes("att-6")) ?? "";
    check("Scenario 6 (valid base64, WRONG decoded length) is NOT graph_recoverable", att6Line.length > 0 && !att6Line.includes("[graph_recoverable]"));
    check("Scenario 6 (valid base64, wrong length) -> graph_metadata_matched_bytes_unavailable with a length-mismatch reason, NOT 'malformed'", att6Line.includes("graph_metadata_matched_bytes_unavailable") && att6Line.includes("decoded to a different length") && !att6Line.includes("malformed"));
    check("Scenario 7 (attachments field entirely absent) -> graph_no_attachment_collection", /graph_no_attachment_collection\s+1/.test(output));
    check("Scenario 7 detail reports hasAttachments=true despite the missing collection", output.includes("hasAttachments=true") && output.includes("no \"attachments\" field"));
    check("Scenario 8 (attachments present but empty) -> graph_empty_attachment_collection", /graph_empty_attachment_collection\s+1/.test(output));
    check("Scenario 9 (unique name match, Graph size disagrees, decoded bytes match NEITHER size) -> graph_metadata_size_mismatch_bytes_differ", output.includes("att-9") && output.includes("graph_metadata_size_mismatch_bytes_differ"));
    check("Scenario 10 (unique name match, Graph size disagrees, decoded bytes match the DB size exactly) -> graph_recoverable_metadata_size_mismatch", output.includes("att-10") && output.includes("graph_recoverable_metadata_size_mismatch"));
    check("Scenario 10 detail names both disagreeing sizes, confirms the decoded length, and uses 'recovery candidate' wording", output.includes("Graph reported size 150") && output.includes("DB recorded size 100") && output.includes("Decoded contentBytes length is exactly 100") && output.includes("recovery candidate despite the metadata disagreement"));
    check("Scenario 11 (unique name match, Graph size disagrees, contentBytes absent) -> graph_metadata_size_mismatch_bytes_unavailable", output.includes("att-11") && output.includes("graph_metadata_size_mismatch_bytes_unavailable"));
    check("Scenario 12 (unique name match, Graph size disagrees, contentBytes NOT well-formed base64) -> graph_metadata_size_mismatch_malformed_base64", output.includes("att-12") && output.includes("graph_metadata_size_mismatch_malformed_base64"));
    check("graph_metadata_size_mismatch_invalid_base64 no longer exists as a classification (renamed to _malformed_base64)", !output.includes("graph_metadata_size_mismatch_invalid_base64"));
    check("graph_attachment_size_mismatch no longer exists as a classification (superseded by the four metadata-size buckets)", !output.includes("graph_attachment_size_mismatch "));
    const att13Line = lines.find((l) => l.includes("att-13")) ?? "";
    check("Scenario 13 (legitimate zero-byte attachment: DB size 0, Graph size 0, contentBytes \"\") -> graph_recoverable, NOT absent/unavailable", att13Line.includes("[graph_recoverable]") && !att13Line.includes("bytes_unavailable"));
    const att14Line = lines.find((l) => l.includes("att-14")) ?? "";
    check("Scenario 14 (straightforward path, size matches, but contentBytes is malformed base64) -> graph_metadata_matched_bytes_unavailable with a malformed reason", att14Line.includes("graph_metadata_matched_bytes_unavailable") && att14Line.includes("not well-formed base64 (malformed)"));
    check("Scenario 14 is NOT silently decoded into a wrong-but-plausible recoverable match", !att14Line.includes("[graph_recoverable]"));
    check("Summary shows exactly 4 graph_recoverable (scenario 1 + 13's zero-byte fix + 2 cross-mailbox collision rows)", /graph_recoverable\s+4/.test(output));
    check("Cross-mailbox collision: distinct-id count is 4, not 3 — the two rows sharing the SAME bare Graph attachment id across DIFFERENT mailboxes are correctly counted as distinct sources, not deduped", /graph_recoverable\s+4 — 4 distinct Graph attachment ids/.test(output));
    check("Summary shows exactly 1 graph_recoverable_metadata_size_mismatch", /graph_recoverable_metadata_size_mismatch\s+1/.test(output));
    check("Summary shows exactly 3 graph_metadata_matched_bytes_unavailable (scenario 2 absent + scenario 6 length-mismatch + scenario 14 malformed)", /graph_metadata_matched_bytes_unavailable\s+3/.test(output));
    check("Summary shows exactly 1 graph_metadata_matched_not_file_type", /graph_metadata_matched_not_file_type\s+1/.test(output));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.emailProcessingLog.deleteMany({ where: { id: { in: logIds } } });
      await prisma.ticketAttachment.deleteMany({ where: { id: { in: attachmentIds } } });
      await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
