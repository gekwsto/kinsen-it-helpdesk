/**
 * Focused regression for scripts/bulk-recover-attachments-from-graph.ts —
 * the sequential, manifest-approved bulk orchestrator built entirely on
 * top of the already-tested scripts/recover-attachment-from-graph.ts
 * (which this test does NOT re-verify in depth — see
 * test-recover-attachment-from-graph.ts for that). Every Graph call is
 * mocked and UPLOAD_DIR is sandboxed to a throwaway OS-temp directory,
 * same conventions as that file.
 *
 * Proves (closure-pass requirements):
 *   A. Manifest generation is deterministic (stable sort, same hash for
 *      the same DB state) and correctly EXCLUDES file-present,
 *      no-email-correlation, and mailbox-unresolved rows.
 *   B. An invalid/mismatched --confirm hash refuses to process ANYTHING
 *      — zero Graph calls, zero file writes, zero per-record attempts.
 *   C. Partial failure: the batch continues past a per-record failure
 *      (byte mismatch) and still processes the remaining entries.
 *   D. Systemic failure: a Graph-authentication-classified error aborts
 *      the REST of the batch immediately, marking untouched entries
 *      "not_attempted" — never silently dropped, never falsely "failed."
 *   E. Resumability: re-running the SAME manifest after some entries are
 *      already recovered reports those as already_present (zero further
 *      Graph calls for them) and still correctly processes the rest —
 *      simulating a genuinely interrupted-then-resumed run.
 *   F. Unrelated/new records are NEVER processed unless they're actually
 *      listed in the approved manifest, even if they'd qualify as
 *      candidates right now.
 *   G. Sequential only: no two recoverAttachment calls are ever
 *      in flight at the same time (verified by timing, not just by
 *      reading the source).
 *   H. The previously-restored attachment (status already_present) is
 *      correctly skipped, with zero further Graph calls for it.
 *
 * Must run with --experimental-test-module-mocks (mocks @/lib/microsoft-graph).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-bulk-recover-attachments-from-graph.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import { mock } from "node:test";

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
const TAG = `gbulk-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);

type MockedGraphAttachment = { id: string; name: string; size: number; contentBytes?: string; "@odata.type": string };
type MockedGraphMessage = { internetMessageId: string; attachments?: MockedGraphAttachment[] };

async function main() {
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR;
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });

  const graphCallLog: Array<{ internetMessageId: string; startedAt: number; finishedAt: number }> = [];
  const mockedMessages = new Map<string, MockedGraphMessage | "AUTH_FAILURE" | null>();
  const callDelaysMs = new Map<string, number>(); // artificial delay, to prove sequentiality via timing

  mock.module("@/lib/microsoft-graph", {
    namedExports: {
      GraphConfigurationError: class GraphConfigurationError extends Error {},
      microsoftGraph: {
        async getMessageByInternetMessageId(_mailbox: string, internetMessageId: string) {
          const startedAt = Date.now();
          const delay = callDelaysMs.get(internetMessageId) ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          const entry = mockedMessages.get(internetMessageId);
          const finishedAt = Date.now();
          graphCallLog.push({ internetMessageId, startedAt, finishedAt });
          if (entry === undefined || entry === null) return null;
          if (entry === "AUTH_FAILURE") throw new Error("Graph API error 403 Forbidden (): insufficient permissions");
          return entry;
        },
        async markAsRead() {
          throw new Error("markAsRead must never be called");
        },
        async moveMessage() {
          throw new Error("moveMessage must never be called");
        },
      },
    },
  });

  const { prisma } = await import("@/lib/prisma");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { Role, AuthProvider, TicketSource } = await import("@prisma/client");
  const { generateManifest, runBulkRecovery, computeManifestHash, sortManifestEntries, validateManifestEntries } = await import("@/scripts/bulk-recover-attachments-from-graph");

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

  const RECOVERABLE_CONTENT = Buffer.from("bulk recovery regression content — fixed length for predictable tests").toString("base64");
  const RECOVERABLE_SIZE = Buffer.from(RECOVERABLE_CONTENT, "base64").length;

  let dept: Awaited<ReturnType<typeof createDepartment>>;
  let user: Awaited<ReturnType<typeof prisma.user.create>>;

  async function makeTicketAttachment(originalName: string, size: number) {
    const emailMessageId = `<${TAG}-${originalName}@example.com>`;
    const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
    const ticket = await prisma.ticket.create({
      data: { title: `${TAG} ticket`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id, emailMessageId },
    });
    ticketIds.push(ticket.id);
    const filename = `${TAG}-${originalName.replace(/[^a-z0-9]/gi, "_")}.bin`;
    const attachment = await prisma.ticketAttachment.create({
      data: { ticketId: ticket.id, uploadedById: user.id, filename, originalName, mimeType: "image/png", size, path: "/x" },
    });
    attachmentIds.push(attachment.id);
    const log = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: emailMessageId, action: "CREATED_TICKET", mailbox: `${TAG}-mb@example.com` } });
    logIds.push(log.id);
    return { ticket, attachment, emailMessageId, filename, destPath: path.join(TEMP_UPLOAD_DIR, ticket.id, filename) };
  }

  try {
    dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    user = await prisma.user.create({ data: { email: `${TAG}-user@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    userIds.push(user.id);

    // ── A — manifest generation: deterministic, and correctly excludes
    //    file-present / no-correlation / mailbox-unresolved rows. ────────
    console.log("\nA — manifest generation is deterministic and excludes ineligible rows...\n");
    {
      const recoverable1 = await makeTicketAttachment("manifest-a1.png", RECOVERABLE_SIZE);
      mockedMessages.set(recoverable1.emailMessageId, { internetMessageId: recoverable1.emailMessageId, attachments: [{ id: "att-a1", name: "manifest-a1.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      const recoverable2 = await makeTicketAttachment("manifest-a2.png", RECOVERABLE_SIZE);
      mockedMessages.set(recoverable2.emailMessageId, { internetMessageId: recoverable2.emailMessageId, attachments: [{ id: "att-a2", name: "manifest-a2.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      // Already present locally — must be excluded.
      const alreadyPresent = await makeTicketAttachment("manifest-present.png", RECOVERABLE_SIZE);
      await fs.mkdir(path.dirname(alreadyPresent.destPath), { recursive: true });
      await fs.writeFile(alreadyPresent.destPath, Buffer.from(RECOVERABLE_CONTENT, "base64"));

      // No email correlation — must be excluded.
      const statusNoCorr = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
      const ticketNoCorr = await prisma.ticket.create({ data: { title: `${TAG} no-corr`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: statusNoCorr.id, emailMessageId: null } });
      ticketIds.push(ticketNoCorr.id);
      const attNoCorr = await prisma.ticketAttachment.create({ data: { ticketId: ticketNoCorr.id, uploadedById: user.id, filename: `${TAG}-nocorr.bin`, originalName: "nocorr.png", mimeType: "image/png", size: 10, path: "/x" } });
      attachmentIds.push(attNoCorr.id);

      // Mailbox unresolved (two distinct mailboxes for the same message) — must be excluded.
      const ambigMsgId = `<${TAG}-ambig@example.com>`;
      const ticketAmbig = await prisma.ticket.create({ data: { title: `${TAG} ambig`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: statusNoCorr.id, emailMessageId: ambigMsgId } });
      ticketIds.push(ticketAmbig.id);
      const attAmbig = await prisma.ticketAttachment.create({ data: { ticketId: ticketAmbig.id, uploadedById: user.id, filename: `${TAG}-ambig.bin`, originalName: "ambig.png", mimeType: "image/png", size: 10, path: "/x" } });
      attachmentIds.push(attAmbig.id);
      const logAmbig1 = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: ambigMsgId, action: "CREATED_TICKET", mailbox: `${TAG}-mbA@example.com` } });
      const logAmbig2 = await prisma.emailProcessingLog.create({ data: { runId: TAG, messageId: ambigMsgId, action: "CREATED_TICKET", mailbox: `${TAG}-mbB@example.com` } });
      logIds.push(logAmbig1.id, logAmbig2.id);

      const manifest1 = await generateManifest();
      const manifest2 = await generateManifest();
      check("A: manifest entries contain exactly the 2 eligible candidates (a1, a2) — present/no-correlation/mailbox-unresolved excluded", manifest1.entries.length === 2 && manifest1.entries.some((e) => e.id === recoverable1.attachment.id) && manifest1.entries.some((e) => e.id === recoverable2.attachment.id) && !manifest1.entries.some((e) => e.id === alreadyPresent.attachment.id) && !manifest1.entries.some((e) => e.id === attNoCorr.id) && !manifest1.entries.some((e) => e.id === attAmbig.id));
      check("A: regenerating against the SAME DB state produces the IDENTICAL hash (deterministic)", manifest1.sha256 === manifest2.sha256);
      check("A: entries are sorted deterministically (stable order across generations)", JSON.stringify(sortManifestEntries(manifest1.entries)) === JSON.stringify(sortManifestEntries(manifest2.entries)));
      check("A: sha256 matches an independent recomputation from the entries alone", manifest1.sha256 === computeManifestHash(manifest1.entries));

      // ── B — invalid confirm hash refuses to process ANYTHING, on BOTH
      //    apply and dry-run calls (the check is unconditional, never
      //    gated by the apply flag). ───────────────────────────────────────
      console.log("\nB — an invalid/mismatched confirm hash refuses to process anything, for apply AND dry-run alike...\n");
      const callsBeforeB = graphCallLog.length;
      const badOutcome = await runBulkRecovery(manifest1, "not-the-real-hash", true);
      check("B: apply outcome is NOT ok", badOutcome.ok === false);
      if (!badOutcome.ok) check("B: reason explains the hash mismatch", /does not match/i.test(badOutcome.reason));
      check("B: zero Graph calls were made (apply)", graphCallLog.length === callsBeforeB);
      check("B: nothing was written for either candidate (apply)", !(await pathExists(recoverable1.destPath)) && !(await pathExists(recoverable2.destPath)));

      const badDryRunOutcome = await runBulkRecovery(manifest1, "a-different-wrong-hash", false);
      check("B-dry-run: dry-run outcome is ALSO NOT ok with a bad hash — the check is not skipped for dry runs", badDryRunOutcome.ok === false);
      check("B-dry-run: still zero Graph calls were made", graphCallLog.length === callsBeforeB);

      // ── I — manifest STRUCTURAL validation: malformed entries, invalid
      //    kind/id, and duplicate (kind,id) pairs are all rejected before
      //    any Graph call or file write — independent of the hash check. ──
      console.log("\nI — structurally invalid manifests are rejected before any Graph call or file write...\n");
      const callsBeforeI = graphCallLog.length;
      const notAnArray = validateManifestEntries("not an array" as unknown);
      check("I: a non-array entries value is rejected", notAnArray.ok === false);

      const badShape = validateManifestEntries([{ kind: "ticket", id: recoverable1.attachment.id }, "not an object"] as unknown);
      check("I: a non-object entry is rejected", badShape.ok === false);
      if (!badShape.ok) check("I: reason identifies the bad entry by index", /index 1/.test(badShape.reason));

      const invalidKind = validateManifestEntries([{ kind: "TICKET", id: recoverable1.attachment.id }] as unknown);
      check("I: an invalid kind (wrong case) is rejected", invalidKind.ok === false);
      if (!invalidKind.ok) check("I: reason mentions the invalid kind", /invalid kind/i.test(invalidKind.reason));

      const invalidId = validateManifestEntries([{ kind: "ticket", id: "" }] as unknown);
      check("I: an empty-string id is rejected", invalidId.ok === false);
      const missingId = validateManifestEntries([{ kind: "ticket", id: 12345 }] as unknown);
      check("I: a non-string id (a number) is rejected", missingId.ok === false);

      const duplicate = validateManifestEntries([{ kind: "ticket", id: recoverable1.attachment.id }, { kind: "ticket", id: recoverable1.attachment.id }] as unknown);
      check("I: a duplicate (kind,id) pair is rejected", duplicate.ok === false);
      if (!duplicate.ok) check("I: reason mentions duplicate", /duplicate/i.test(duplicate.reason));

      // Each of these, run through the FULL runBulkRecovery (not just the
      // validator in isolation), must also refuse before any Graph call.
      const malformedManifest = { entries: [{ kind: "ticket", id: recoverable1.attachment.id }, { kind: "ticket", id: recoverable1.attachment.id }] };
      const malformedOutcome = await runBulkRecovery(malformedManifest, computeManifestHash(malformedManifest.entries as never), true);
      check("I: runBulkRecovery rejects a structurally invalid manifest outright", malformedOutcome.ok === false);
      if (!malformedOutcome.ok) check("I: runBulkRecovery's reason mentions the invalid manifest", /invalid manifest/i.test(malformedOutcome.reason));
      check("I: zero Graph calls were made for any of the structural-validation checks above", graphCallLog.length === callsBeforeI);
      check("I: nothing was written for recoverable1 as a side effect of these invalid-manifest attempts", !(await pathExists(recoverable1.destPath)));

      // ── Full, correctly-confirmed dry run then apply, for use by later
      //    scenarios (E, F, G, H) which build on this same manifest. ─────
      console.log("\n(continuing A's manifest into a real dry-run then apply)\n");
      const dryRun = await runBulkRecovery(manifest1, manifest1.sha256, false);
      check("A-continued: confirmed dry-run outcome is ok", dryRun.ok === true);
      if (dryRun.ok) {
        check("A-continued: dry-run mode is dry_run", dryRun.result.mode === "dry_run");
        check("A-continued: dry-run succeeded count is 2, failed 0", dryRun.result.succeededCount === 2 && dryRun.result.failedCount === 0);
      }
      check("A-continued: dry-run wrote nothing", !(await pathExists(recoverable1.destPath)) && !(await pathExists(recoverable2.destPath)));

      const applyRun = await runBulkRecovery(manifest1, manifest1.sha256, true);
      check("A-continued: apply outcome is ok", applyRun.ok === true);
      if (applyRun.ok) check("A-continued: apply succeeded count is 2", applyRun.result.succeededCount === 2 && applyRun.result.failedCount === 0);
      check("A-continued: both files now exist with the correct content", (await fs.readFile(recoverable1.destPath)).equals(Buffer.from(RECOVERABLE_CONTENT, "base64")) && (await fs.readFile(recoverable2.destPath)).equals(Buffer.from(RECOVERABLE_CONTENT, "base64")));

      // ── H — the previously-restored attachment is skipped as
      //    already_present, with zero further Graph calls for it. ───────
      console.log("\nH — re-processing the same manifest skips already-recovered entries with zero further Graph calls...\n");
      const callsBeforeH = graphCallLog.filter((c) => c.internetMessageId === recoverable1.emailMessageId).length;
      const secondApply = await runBulkRecovery(manifest1, manifest1.sha256, true);
      check("H: second apply outcome is ok", secondApply.ok === true);
      if (secondApply.ok) {
        const rec1Outcome = secondApply.result.records.find((r) => r.id === recoverable1.attachment.id);
        check("H: recoverable1's second-run status is already_present", rec1Outcome?.status === "already_present");
      }
      const callsAfterH = graphCallLog.filter((c) => c.internetMessageId === recoverable1.emailMessageId).length;
      check("H: NO further Graph call was made for the already-recovered record", callsAfterH === callsBeforeH);

      // ── F — a brand-new candidate created AFTER manifest generation is
      //    NEVER processed when re-running the SAME (old) manifest. ─────
      console.log("\nF — a new candidate created after manifest generation is never processed under the old manifest...\n");
      const lateArrival = await makeTicketAttachment("late-arrival.png", RECOVERABLE_SIZE);
      mockedMessages.set(lateArrival.emailMessageId, { internetMessageId: lateArrival.emailMessageId, attachments: [{ id: "att-late", name: "late-arrival.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });
      const thirdApply = await runBulkRecovery(manifest1, manifest1.sha256, true);
      check("F: outcome is ok", thirdApply.ok === true);
      if (thirdApply.ok) check("F: the late-arriving record is NOT among the processed records at all", !thirdApply.result.records.some((r) => r.id === lateArrival.attachment.id));
      check("F: the late-arriving record's file was never written", !(await pathExists(lateArrival.destPath)));
    }

    // ── C — partial failure: a byte-mismatched record fails individually
    //    but the batch continues to the remaining entries. ────────────────
    console.log("\nC — the batch continues past an individual byte-mismatch failure...\n");
    {
      const good = await makeTicketAttachment("partial-good.png", RECOVERABLE_SIZE);
      mockedMessages.set(good.emailMessageId, { internetMessageId: good.emailMessageId, attachments: [{ id: "att-good", name: "partial-good.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      const bad = await makeTicketAttachment("partial-bad.png", 99999 /* DB expects 99999, Graph will decode to RECOVERABLE_SIZE */);
      mockedMessages.set(bad.emailMessageId, { internetMessageId: bad.emailMessageId, attachments: [{ id: "att-bad", name: "partial-bad.png", size: 99999, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      const manifest: import("@/scripts/bulk-recover-attachments-from-graph").Manifest = {
        generatedAt: new Date().toISOString(),
        candidateCount: 2,
        filePresentCount: 0,
        noEmailCorrelationCount: 0,
        mailboxUnresolvedCount: 0,
        sha256: "",
        entries: [{ kind: "ticket", id: good.attachment.id }, { kind: "ticket", id: bad.attachment.id }],
      };
      manifest.sha256 = computeManifestHash(manifest.entries);

      const outcome = await runBulkRecovery(manifest, manifest.sha256, true);
      check("C: outcome is ok", outcome.ok === true);
      if (outcome.ok) {
        check("C: batch did NOT abort early", outcome.result.abortedEarly === false);
        check("C: exactly 1 succeeded and 1 failed", outcome.result.succeededCount === 1 && outcome.result.failedCount === 1);
        check("C: exactly 0 not_attempted (the batch continued through everything)", outcome.result.notAttemptedCount === 0);
        const badOutcome2 = outcome.result.records.find((r) => r.id === bad.attachment.id);
        check("C: the bad record's failure is NOT marked systemic", badOutcome2?.systemic !== true);
      }
      check("C: the good record was still written correctly despite the bad one failing", (await fs.readFile(good.destPath)).equals(Buffer.from(RECOVERABLE_CONTENT, "base64")));
      check("C: the bad record wrote nothing", !(await pathExists(bad.destPath)));
    }

    // ── D — systemic failure aborts the rest of the batch. ────────────────
    console.log("\nD — a Graph-authentication-classified failure aborts the remaining batch...\n");
    {
      const before = await makeTicketAttachment("systemic-before.png", RECOVERABLE_SIZE);
      mockedMessages.set(before.emailMessageId, { internetMessageId: before.emailMessageId, attachments: [{ id: "att-before", name: "systemic-before.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      const failing = await makeTicketAttachment("systemic-failing.png", RECOVERABLE_SIZE);
      mockedMessages.set(failing.emailMessageId, "AUTH_FAILURE");

      const after = await makeTicketAttachment("systemic-after.png", RECOVERABLE_SIZE);
      mockedMessages.set(after.emailMessageId, { internetMessageId: after.emailMessageId, attachments: [{ id: "att-after", name: "systemic-after.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      const manifest: import("@/scripts/bulk-recover-attachments-from-graph").Manifest = {
        generatedAt: new Date().toISOString(),
        candidateCount: 3,
        filePresentCount: 0,
        noEmailCorrelationCount: 0,
        mailboxUnresolvedCount: 0,
        sha256: "",
        entries: [{ kind: "ticket", id: before.attachment.id }, { kind: "ticket", id: failing.attachment.id }, { kind: "ticket", id: after.attachment.id }],
      };
      manifest.sha256 = computeManifestHash(manifest.entries);

      const outcome = await runBulkRecovery(manifest, manifest.sha256, true);
      check("D: outcome is ok", outcome.ok === true);
      if (outcome.ok) {
        check("D: batch DID abort early", outcome.result.abortedEarly === true);
        check("D: abort reason mentions the failing record", outcome.result.abortReason?.includes(failing.attachment.id) ?? false);
        const beforeOutcome = outcome.result.records.find((r) => r.id === before.attachment.id);
        const failingOutcome = outcome.result.records.find((r) => r.id === failing.attachment.id);
        const afterOutcome = outcome.result.records.find((r) => r.id === after.attachment.id);
        check("D: the record BEFORE the systemic failure completed normally (published)", beforeOutcome?.status === "published");
        check("D: the failing record is marked failed+systemic", failingOutcome?.status === "failed" && failingOutcome?.systemic === true);
        check("D: the record AFTER the systemic failure is marked not_attempted, never silently dropped", afterOutcome?.status === "not_attempted");
      }
      check("D: the before-record's file exists", await pathExists(before.destPath));
      check("D: the after-record's file was never written (batch stopped before reaching it)", !(await pathExists(after.destPath)));
    }

    // ── E — resumability: re-running after a simulated interruption. ──────
    console.log("\nE — resuming a manifest after a simulated interruption (partial prior progress)...\n");
    {
      const r1 = await makeTicketAttachment("resume-1.png", RECOVERABLE_SIZE);
      mockedMessages.set(r1.emailMessageId, { internetMessageId: r1.emailMessageId, attachments: [{ id: "att-resume1", name: "resume-1.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });
      const r2 = await makeTicketAttachment("resume-2.png", RECOVERABLE_SIZE);
      mockedMessages.set(r2.emailMessageId, { internetMessageId: r2.emailMessageId, attachments: [{ id: "att-resume2", name: "resume-2.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });

      const fullManifestEntries = [{ kind: "ticket" as const, id: r1.attachment.id }, { kind: "ticket" as const, id: r2.attachment.id }];
      const fullHash = computeManifestHash(fullManifestEntries);

      // Simulate "the first run only got through r1 before being interrupted."
      const partialManifest: import("@/scripts/bulk-recover-attachments-from-graph").Manifest = { generatedAt: new Date().toISOString(), candidateCount: 1, filePresentCount: 0, noEmailCorrelationCount: 0, mailboxUnresolvedCount: 0, sha256: "", entries: [fullManifestEntries[0]] };
      partialManifest.sha256 = computeManifestHash(partialManifest.entries);
      const firstRun = await runBulkRecovery(partialManifest, partialManifest.sha256, true);
      check("E: simulated first (interrupted) run recovered r1", firstRun.ok === true && (await pathExists(r1.destPath)));
      check("E: r2 was NOT touched by the interrupted run", !(await pathExists(r2.destPath)));

      // "Resume" with the FULL manifest.
      const fullManifest: import("@/scripts/bulk-recover-attachments-from-graph").Manifest = { generatedAt: new Date().toISOString(), candidateCount: 2, filePresentCount: 0, noEmailCorrelationCount: 0, mailboxUnresolvedCount: 0, sha256: fullHash, entries: fullManifestEntries };
      const resumeRun = await runBulkRecovery(fullManifest, fullHash, true);
      check("E: resume run outcome is ok", resumeRun.ok === true);
      if (resumeRun.ok) {
        const r1Outcome = resumeRun.result.records.find((r) => r.id === r1.attachment.id);
        const r2Outcome = resumeRun.result.records.find((r) => r.id === r2.attachment.id);
        check("E: r1 (already recovered) reports already_present on resume", r1Outcome?.status === "already_present");
        check("E: r2 (never attempted before) is correctly published on resume", r2Outcome?.status === "published");
        check("E: resume run did not abort and had zero failures", resumeRun.result.abortedEarly === false && resumeRun.result.failedCount === 0);
      }
    }

    // ── G — sequential only: no two Graph calls ever overlap in time. ─────
    console.log("\nG — recoverAttachment calls are strictly sequential, never overlapping...\n");
    {
      const s1 = await makeTicketAttachment("sequential-1.png", RECOVERABLE_SIZE);
      mockedMessages.set(s1.emailMessageId, { internetMessageId: s1.emailMessageId, attachments: [{ id: "att-seq1", name: "sequential-1.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });
      const s2 = await makeTicketAttachment("sequential-2.png", RECOVERABLE_SIZE);
      mockedMessages.set(s2.emailMessageId, { internetMessageId: s2.emailMessageId, attachments: [{ id: "att-seq2", name: "sequential-2.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });
      const s3 = await makeTicketAttachment("sequential-3.png", RECOVERABLE_SIZE);
      mockedMessages.set(s3.emailMessageId, { internetMessageId: s3.emailMessageId, attachments: [{ id: "att-seq3", name: "sequential-3.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }] });
      callDelaysMs.set(s1.emailMessageId, 60);
      callDelaysMs.set(s2.emailMessageId, 60);
      callDelaysMs.set(s3.emailMessageId, 60);

      const entries = [{ kind: "ticket" as const, id: s1.attachment.id }, { kind: "ticket" as const, id: s2.attachment.id }, { kind: "ticket" as const, id: s3.attachment.id }];
      const hash = computeManifestHash(entries);
      const manifest: import("@/scripts/bulk-recover-attachments-from-graph").Manifest = { generatedAt: new Date().toISOString(), candidateCount: 3, filePresentCount: 0, noEmailCorrelationCount: 0, mailboxUnresolvedCount: 0, sha256: hash, entries };

      const logBefore = graphCallLog.length;
      await runBulkRecovery(manifest, hash, true);
      const relevantCalls = graphCallLog.slice(logBefore).filter((c) => [s1.emailMessageId, s2.emailMessageId, s3.emailMessageId].includes(c.internetMessageId));
      check("G: all 3 delayed Graph calls were made", relevantCalls.length === 3);
      let overlapped = false;
      for (let i = 1; i < relevantCalls.length; i++) {
        if (relevantCalls[i].startedAt < relevantCalls[i - 1].finishedAt) overlapped = true;
      }
      check("G: no two Graph calls ever overlapped in time (each one's start was AFTER the previous one's finish)", !overlapped);
    }
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
      console.warn("DB cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    try {
      await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true });
    } catch (err) {
      console.warn("Temp UPLOAD_DIR cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

main();
