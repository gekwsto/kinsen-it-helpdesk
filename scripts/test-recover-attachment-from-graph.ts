/**
 * Focused regression for scripts/recover-attachment-from-graph.ts — the
 * single-record, write-capable Graph attachment recovery tool. Every Graph
 * call is mocked (mock.module on "@/lib/microsoft-graph", same pattern as
 * every other focused test in this suite) and UPLOAD_DIR is sandboxed to a
 * throwaway OS-temp directory (process.env.UPLOAD_DIR is set BEFORE
 * anything that reads it is ever imported) so this test can never write
 * into the real storage/uploads tree. All DB fixtures are synthetic,
 * created and torn down against the local test database like every other
 * script in this suite.
 *
 * Proves (closure-pass requirements):
 *   A. SUCCESS — dry-run performs the real (mocked) Graph verification but
 *      writes nothing; apply then writes the file at the exact canonical
 *      path, with on-disk bytes matching the decoded Graph content
 *      byte-for-byte, and leaves the DB row completely unchanged. Graph's
 *      reported (wrong) metadata size is proven to be ignored.
 *   B. IDEMPOTENCY — a second apply on the same, now-recovered record is a
 *      no-op (status "already_present"), makes no further Graph call, and
 *      never touches the already-written file.
 *   C. CONCURRENT ATTEMPTS — publishRecoveredFile, tested directly: when
 *      the destination already holds different (sentinel) content, it
 *      reports "already_exists" without throwing, and the destination's
 *      content is proven byte-for-byte unchanged afterward.
 *   D. UNSAFE FILENAMES — a row with a path-traversal filename is rejected
 *      before any Graph call is even attempted.
 *   E. MISMATCHED BYTES — Graph's contentBytes decodes to a different
 *      length than the DB's own recorded size (even with well-formed
 *      base64 and a superficially-matching Graph `size`): aborts with
 *      zero bytes written and no stray temp file left behind.
 *   F. FAILURE RECOVERY — writeAndVerifyTempFile, tested directly with an
 *      injected "disk lies to us" read-back: detects the mismatch, cleans
 *      up its own temp file, and leaves an unrelated pre-existing file in
 *      the same directory completely untouched.
 *
 * Must run with --experimental-test-module-mocks (mocks @/lib/microsoft-graph).
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-recover-attachment-from-graph.ts
 * Requires a reachable DATABASE_URL — reports clearly and exits if unreachable.
 */
import os from "os";
import path from "path";
import fsSync from "fs";
import fs from "fs/promises";
import { createHash } from "crypto";
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
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const RUN_ID = Date.now();
const TAG = `grecover-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);

type MockedGraphAttachment = { id: string; name: string; size: number; contentBytes?: string; "@odata.type": string };
type MockedGraphMessage = { internetMessageId: string; attachments?: MockedGraphAttachment[] };

async function main() {
  // Sandbox UPLOAD_DIR BEFORE any module that reads it (lib/attachment-policy,
  // and transitively this tool) is ever imported — tsconfig path-alias
  // imports below are all dynamic (`await import(...)`) specifically so
  // this assignment runs first.
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR;
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });

  const graphCalls: Array<{ mailbox: string; internetMessageId: string }> = [];
  const mockedMessages = new Map<string, MockedGraphMessage | "MISMATCH" | null>();
  // Keyed by emailMessageId — if present, runs as a side effect INSIDE the
  // mocked Graph call, before it returns. Used by scenario G below to
  // deterministically simulate a competing writer creating the destination
  // file in the exact window between recoverAttachment's own early
  // existence check (which runs BEFORE the Graph call) and its publish
  // step (which runs AFTER) — the real race this tool must survive.
  const raceSideEffects = new Map<string, () => Promise<void>>();

  mock.module("@/lib/microsoft-graph", {
    namedExports: {
      GraphConfigurationError: class GraphConfigurationError extends Error {},
      microsoftGraph: {
        async getMessageByInternetMessageId(mailbox: string, internetMessageId: string) {
          graphCalls.push({ mailbox, internetMessageId });
          const sideEffect = raceSideEffects.get(internetMessageId);
          if (sideEffect) await sideEffect();
          const entry = mockedMessages.get(internetMessageId);
          if (entry === undefined || entry === null) return null;
          if (entry === "MISMATCH") return { internetMessageId: `<wrong-${RUN_ID}@test.local>`, attachments: [] };
          return entry;
        },
        // Never called by the recovery tool — present only so a stray call
        // fails loudly instead of silently no-op-ing.
        async markAsRead() {
          throw new Error("markAsRead must never be called by the recovery tool");
        },
        async moveMessage() {
          throw new Error("moveMessage must never be called by the recovery tool");
        },
      },
    },
  });

  const { prisma } = await import("@/lib/prisma");
  const { createDepartment } = await import("@/lib/services/department-service");
  const { Role, AuthProvider, TicketSource } = await import("@prisma/client");
  const { recoverAttachment, writeAndVerifyTempFile, publishRecoveredFile } = await import("@/scripts/recover-attachment-from-graph");

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

  // Real, well-formed base64 content — decodes to a known, fixed byte count.
  const RECOVERABLE_CONTENT = Buffer.from("hello world, this is the recoverable attachment content").toString("base64");
  const RECOVERABLE_SIZE = Buffer.from(RECOVERABLE_CONTENT, "base64").length;

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
    return { ticket, attachment, emailMessageId, filename };
  }

  let dept: Awaited<ReturnType<typeof createDepartment>>;
  let user: Awaited<ReturnType<typeof prisma.user.create>>;

  try {
    dept = await createDepartment({ name: `${TAG}-dept`, slug: `${TAG}-dept` });
    departmentIds.push(dept.id);
    user = await prisma.user.create({ data: { email: `${TAG}-user@example.com`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash: "x" } });
    userIds.push(user.id);

    // ── A — SUCCESS: dry-run verifies without writing; apply writes the
    //    exact bytes; Graph's WRONG metadata size is proven ignored; DB row
    //    is proven unchanged. ──────────────────────────────────────────────
    console.log("\nA — success path: dry-run verifies without writing, apply writes exact bytes, DB untouched...\n");
    {
      const { ticket, attachment, emailMessageId, filename } = await makeTicketAttachment("success.png", RECOVERABLE_SIZE);
      mockedMessages.set(emailMessageId, {
        internetMessageId: emailMessageId,
        attachments: [{ id: "att-success", name: "success.png", size: 999999 /* deliberately WRONG vs. DB's RECOVERABLE_SIZE — must be ignored */, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }],
      });
      const destPath = path.join(TEMP_UPLOAD_DIR, ticket.id, filename);

      const dryRun = await recoverAttachment("ticket", attachment.id, false);
      check("A: dry-run result is ok", dryRun.ok === true);
      if (dryRun.ok && dryRun.status === "dry_run_verified") {
        check("A: dry-run expected size matches DB size (Graph's wrong metadata size ignored)", dryRun.expectedSize === RECOVERABLE_SIZE);
        check("A: dry-run sha256 matches the real decoded content", dryRun.sha256 === createHash("sha256").update(Buffer.from(RECOVERABLE_CONTENT, "base64")).digest("hex"));
        check("A: dry-run reports the correct Graph attachment id", dryRun.graphAttachmentId === "att-success");
      } else {
        check("A: dry-run status is dry_run_verified", false, JSON.stringify(dryRun));
      }
      check("A: dry-run wrote NOTHING to disk", !(await pathExists(destPath)));

      const applyResult = await recoverAttachment("ticket", attachment.id, true);
      check("A: apply result is ok", applyResult.ok === true);
      if (applyResult.ok && applyResult.status === "published") {
        check("A: apply written size matches expected", applyResult.writtenSize === RECOVERABLE_SIZE);
        check("A: apply sha256 matches the dry-run's own sha256", applyResult.sha256 === (dryRun.ok && dryRun.status === "dry_run_verified" ? dryRun.sha256 : null));
      } else {
        check("A: apply status is published", false, JSON.stringify(applyResult));
      }
      check("A: file now exists at the exact canonical destination path", await pathExists(destPath));
      const onDisk = await fs.readFile(destPath);
      check("A: on-disk bytes are EXACTLY the decoded Graph content, byte-for-byte", onDisk.equals(Buffer.from(RECOVERABLE_CONTENT, "base64")));
      const ticketDirEntries = await fs.readdir(path.join(TEMP_UPLOAD_DIR, ticket.id));
      check("A: ticket's directory contains EXACTLY the recovered file — no stray temp artifact left behind (proves the temp file lived in, and was cleaned up within, the SAME directory as the destination)", ticketDirEntries.length === 1 && ticketDirEntries[0] === filename);

      const dbRow = await prisma.ticketAttachment.findUnique({ where: { id: attachment.id } });
      check("A: DB row's filename/originalName/mimeType/size/path are all EXACTLY unchanged", dbRow?.filename === filename && dbRow?.originalName === "success.png" && dbRow?.mimeType === "image/png" && dbRow?.size === RECOVERABLE_SIZE && dbRow?.path === "/x");

      // ── B — IDEMPOTENCY: a second apply is a clean no-op. ────────────────
      console.log("\nB — idempotency: a second apply on the already-recovered record is a no-op...\n");
      const callsBeforeSecondApply = graphCalls.length;
      const secondApply = await recoverAttachment("ticket", attachment.id, true);
      check("B: second apply result is ok", secondApply.ok === true);
      if (secondApply.ok) check("B: second apply status is already_present", secondApply.status === "already_present");
      check("B: second apply made NO further Graph call (short-circuited by the local existence check)", graphCalls.length === callsBeforeSecondApply);
      const onDiskAfterSecondApply = await fs.readFile(destPath);
      check("B: file content is still byte-for-byte identical after the second apply", onDiskAfterSecondApply.equals(Buffer.from(RECOVERABLE_CONTENT, "base64")));
    }

    // ── C — CONCURRENT ATTEMPTS: publishRecoveredFile never overwrites an
    //    existing destination, even when called directly. ─────────────────
    console.log("\nC — concurrent attempts: publishRecoveredFile reports already_exists and never overwrites...\n");
    {
      const tempPath = path.join(TEMP_UPLOAD_DIR, `concurrent-temp-${RUN_ID}.tmp`);
      const finalPath = path.join(TEMP_UPLOAD_DIR, `concurrent-final-${RUN_ID}.bin`);
      const sentinelContent = Buffer.from("PRE-EXISTING SENTINEL CONTENT - MUST NEVER CHANGE");
      await fs.writeFile(finalPath, sentinelContent);
      await fs.writeFile(tempPath, Buffer.from("different content that must never overwrite the sentinel"));

      const result = await publishRecoveredFile(tempPath, finalPath);
      check("C: publishRecoveredFile reports already_exists (does not throw) when the destination is occupied", result === "already_exists");
      const stillSentinel = await fs.readFile(finalPath);
      check("C: destination content is STILL the original sentinel — never overwritten", stillSentinel.equals(sentinelContent));
      check("C: publishRecoveredFile leaves tempPath in place on already_exists (cleanup is the caller's job)", await pathExists(tempPath));

      await fs.unlink(tempPath).catch(() => {});
      await fs.unlink(finalPath).catch(() => {});

      // Sanity: a normal (non-colliding) publish DOES succeed and does clean
      // up its own temp file.
      const tempPath2 = path.join(TEMP_UPLOAD_DIR, `normal-temp-${RUN_ID}.tmp`);
      const finalPath2 = path.join(TEMP_UPLOAD_DIR, `normal-final-${RUN_ID}.bin`);
      await fs.writeFile(tempPath2, Buffer.from("normal publish content"));
      const normalResult = await publishRecoveredFile(tempPath2, finalPath2);
      check("C-sanity: a normal publish (no collision) reports published", normalResult === "published");
      check("C-sanity: the temp file is gone after a successful publish", !(await pathExists(tempPath2)));
      check("C-sanity: the final file now holds the published content", (await fs.readFile(finalPath2)).toString() === "normal publish content");
      await fs.unlink(finalPath2).catch(() => {});
    }

    // ── D — UNSAFE FILENAMES: rejected before any Graph call. ─────────────
    console.log("\nD — a path-traversal filename on the record is rejected before any Graph call...\n");
    {
      const emailMessageId = `<${TAG}-unsafe@example.com>`;
      const status = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
      const ticket = await prisma.ticket.create({
        data: { title: `${TAG} unsafe ticket`, description: "d", source: TicketSource.WEB, requesterId: user.id, departmentId: dept.id, statusId: status.id, emailMessageId },
      });
      ticketIds.push(ticket.id);
      const attachment = await prisma.ticketAttachment.create({
        data: { ticketId: ticket.id, uploadedById: user.id, filename: "../../etc/passwd", originalName: "unsafe.png", mimeType: "image/png", size: 10, path: "/x" },
      });
      attachmentIds.push(attachment.id);

      const callsBefore = graphCalls.length;
      const result = await recoverAttachment("ticket", attachment.id, true);
      check("D: unsafe-filename result is NOT ok", result.ok === false);
      if (!result.ok) check("D: reason mentions the unsafe filename", /unsafe filename/i.test(result.reason));
      check("D: NO Graph call was even attempted", graphCalls.length === callsBefore);
    }

    // ── E — MISMATCHED BYTES: decoded length disagrees with the DB's own
    //    recorded size, even though base64 is well-formed and Graph's own
    //    size field superficially matches — must still abort. ─────────────
    console.log("\nE — decoded bytes mismatching the DB's recorded size aborts with zero writes...\n");
    {
      const dbSize = 99999; // deliberately NOT equal to RECOVERABLE_SIZE
      const { ticket, attachment, emailMessageId, filename } = await makeTicketAttachment("mismatch.png", dbSize);
      mockedMessages.set(emailMessageId, {
        internetMessageId: emailMessageId,
        attachments: [{ id: "att-mismatch", name: "mismatch.png", size: dbSize /* Graph's size field AGREES with DB, to prove this check is NOT fooled by metadata agreement */, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }],
      });

      const result = await recoverAttachment("ticket", attachment.id, true);
      check("E: mismatched-bytes result is NOT ok", result.ok === false);
      if (!result.ok) check("E: reason mentions the byte mismatch", /decoded to .* bytes, but the DB record/i.test(result.reason));
      const destPath = path.join(TEMP_UPLOAD_DIR, ticket.id, filename);
      check("E: nothing written to the final destination", !(await pathExists(destPath)));
      const ticketDirEntries = fsSync.existsSync(path.join(TEMP_UPLOAD_DIR, ticket.id)) ? await fs.readdir(path.join(TEMP_UPLOAD_DIR, ticket.id)) : [];
      check("E: no stray temp file left behind in the ticket's directory either", ticketDirEntries.length === 0);
    }

    // ── F — FAILURE RECOVERY: writeAndVerifyTempFile cleans up after a
    //    detected disk-read mismatch, leaving unrelated files untouched. ──
    console.log("\nF — writeAndVerifyTempFile detects a disk-read mismatch, cleans up, and leaves unrelated files alone...\n");
    {
      const tempPath = path.join(TEMP_UPLOAD_DIR, `failure-temp-${RUN_ID}.tmp`);
      const realBuffer = Buffer.from("the real, correct content that was supposedly written");
      const corruptedReadBack = async () => Buffer.from("CORRUPTED — entirely different content, simulating a disk-level fault");

      const unrelatedPath = path.join(TEMP_UPLOAD_DIR, `unrelated-${RUN_ID}.txt`);
      await fs.writeFile(unrelatedPath, "unrelated pre-existing file, must survive untouched");

      const result = await writeAndVerifyTempFile(realBuffer, tempPath, corruptedReadBack);
      check("F: writeAndVerifyTempFile detects the mismatch and reports failure", result.ok === false);
      if (!result.ok) check("F: failure reason mentions verification failure", /verification failed/i.test(result.reason));
      check("F: the temp file is cleaned up even after a verification failure", !(await pathExists(tempPath)));
      const unrelatedContent = await fs.readFile(unrelatedPath, "utf8");
      check("F: a pre-existing unrelated file in the same directory is completely untouched", unrelatedContent === "unrelated pre-existing file, must survive untouched");
      await fs.unlink(unrelatedPath).catch(() => {});

      // Sanity: a normal, non-corrupted write succeeds and LEAVES the temp
      // file in place (publication is a separate, explicit step).
      const tempPath2 = path.join(TEMP_UPLOAD_DIR, `success-temp-${RUN_ID}.tmp`);
      const normalResult = await writeAndVerifyTempFile(realBuffer, tempPath2);
      check("F-sanity: a normal write succeeds", normalResult.ok === true);
      if (normalResult.ok) check("F-sanity: returns the correct sha256", normalResult.sha256 === createHash("sha256").update(realBuffer).digest("hex"));
      check("F-sanity: the temp file is LEFT IN PLACE on success (not auto-deleted — publishing is a separate step)", await pathExists(tempPath2));
      await fs.unlink(tempPath2).catch(() => {});
    }

    // ── G — CONCURRENT INTEGRATION: a competing writer creates the exact
    //    destination file in the real window between recoverAttachment's
    //    own early existence check (before the Graph call) and its publish
    //    step (after it) — exercised through the FULL public function, not
    //    just the isolated publishRecoveredFile unit (scenario C). ────────
    console.log("\nG — concurrent integration: a competing writer wins the race inside a real recoverAttachment(..., apply=true) call...\n");
    {
      const { ticket, attachment, emailMessageId, filename } = await makeTicketAttachment("concurrent-race.png", RECOVERABLE_SIZE);
      mockedMessages.set(emailMessageId, {
        internetMessageId: emailMessageId,
        attachments: [{ id: "att-race", name: "concurrent-race.png", size: RECOVERABLE_SIZE, contentBytes: RECOVERABLE_CONTENT, "@odata.type": "#microsoft.graph.fileAttachment" }],
      });
      const destPath = path.join(TEMP_UPLOAD_DIR, ticket.id, filename);
      const sentinelContent = Buffer.from("COMPETING WRITER GOT HERE FIRST — MUST NEVER BE OVERWRITTEN");
      raceSideEffects.set(emailMessageId, async () => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, sentinelContent);
      });

      const result = await recoverAttachment("ticket", attachment.id, true);
      check("G: result is ok", result.ok === true);
      if (result.ok) check("G: status is concurrent_winner_detected", result.status === "concurrent_winner_detected");
      const finalContent = await fs.readFile(destPath);
      check("G: destination STILL holds the competing writer's content — our own run never overwrote it", finalContent.equals(sentinelContent));
      const raceDirEntries = await fs.readdir(path.join(TEMP_UPLOAD_DIR, ticket.id));
      check("G: exactly one file remains in the directory (the competitor's) — our own temp file was cleaned up via the outer finally", raceDirEntries.length === 1 && raceDirEntries[0] === filename);
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

main();
