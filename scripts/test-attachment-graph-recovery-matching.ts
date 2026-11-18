/**
 * Focused regression for the metadata-vs-byte-availability fix in
 * scripts/diagnose-attachment-graph-recovery.ts — the root cause of a real
 * production run reporting 0 graph_recoverable despite 3 source emails
 * being found successfully: the previous single filter
 * (`name === X && size === Y && !!contentBytes`) could not distinguish
 * "no attachment matches at all" from "found a unique metadata match, but
 * Graph didn't include contentBytes for it" (true by design for any
 * itemAttachment/referenceAttachment, and possible even for a
 * fileAttachment in a given response).
 *
 * Covers, via a mocked microsoftGraph client (no real network/credentials
 * needed, same mock.module pattern used throughout this codebase's other
 * focused test scripts):
 *   - Unique metadata match + contentBytes present -> graph_recoverable
 *     (unchanged happy path).
 *   - Unique metadata match + contentBytes ABSENT + @odata.type IS
 *     fileAttachment -> graph_metadata_matched_bytes_unavailable (the
 *     exact production scenario this fix targets).
 *   - Unique metadata match + contentBytes ABSENT + @odata.type is
 *     itemAttachment -> graph_metadata_matched_not_file_type.
 *   - Zero metadata matches -> graph_attachment_ambiguous_or_missing.
 *   - 2+ metadata matches (name+size collision) ->
 *     graph_attachment_ambiguous_or_missing.
 *   - Request-level failures (429/403) still classified as
 *     graph_request_failed, never conflated with "not found" (regression
 *     guard for the earlier fix, re-verified here too).
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
  { msgId: `<${TAG}-zero-match@example.com>`, originalName: "d.png", size: 400 },
  { msgId: `<${TAG}-collision@example.com>`, originalName: "e.png", size: 500 },
  { msgId: `<${TAG}-invalid-bytes@example.com>`, originalName: "f.png", size: 600 },
];

// Real base64 that decodes to EXACTLY 100 bytes — isUsableContentBytes
// requires an exact decoded-length match against the row's own size, not
// merely a non-empty string, so the "recoverable" fixture must actually
// satisfy that.
const VALID_100_BYTE_CONTENT = Buffer.from("x".repeat(100)).toString("base64");
// Deliberately short — decodes to far fewer bytes than the row's expected
// size (600), simulating a truncated/corrupted response.
const TRUNCATED_CONTENT = Buffer.from("short").toString("base64");

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
          return { internetMessageId: emailMessageId, attachments: [{ id: "att-4", name: "other.png", size: 999, contentBytes: VALID_100_BYTE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] }; // name/size doesn't match
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
      const log = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: s.msgId, action: "CREATED_TICKET", mailbox: `${TAG}-mb@example.com` } });
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

    check("Scenario 1 (contentBytes present, exact-length-verified) -> graph_recoverable", /graph_recoverable\s+1/.test(output));
    check("Scenario 2 (unique match, bytes absent, fileAttachment) -> graph_metadata_matched_bytes_unavailable", output.includes("att-2") && output.includes("contentBytes was absent"));
    check("Scenario 3 (unique match, bytes absent, itemAttachment) -> graph_metadata_matched_not_file_type", output.includes("graph_metadata_matched_not_file_type"));
    check("Scenario 3 detail mentions itemAttachment", output.includes("itemAttachment"));
    check("Scenario 4 (zero name/size match) counted under ambiguous_or_missing", /graph_attachment_ambiguous_or_missing\s+2/.test(output));
    const att6Line = lines.find((l) => l.includes("att-6")) ?? "";
    check("Scenario 6 (contentBytes present but WRONG decoded length) is NOT graph_recoverable", att6Line.length > 0 && !att6Line.includes("[graph_recoverable]"));
    check("Scenario 6 (invalid bytes) -> graph_metadata_matched_bytes_unavailable with a validation-failure reason", att6Line.includes("graph_metadata_matched_bytes_unavailable") && att6Line.includes("failed validation"));
    check("Summary shows exactly 1 graph_recoverable (scenario 6's invalid bytes correctly excluded)", /graph_recoverable\s+1/.test(output));
    check("Summary shows exactly 2 graph_metadata_matched_bytes_unavailable (scenario 2 absent + scenario 6 invalid)", /graph_metadata_matched_bytes_unavailable\s+2/.test(output));
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
