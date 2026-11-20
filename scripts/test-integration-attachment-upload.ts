/**
 * Focused tests for POST /api/integrations/tickets/[ticketId]/attachments —
 * the AI Agent / external-integration attachment endpoint — and its
 * concurrency-safe idempotency layer (lib/services/integration-attachment-
 * service.ts).
 *
 * Proves, against the REAL route handler and a sandboxed real UPLOAD_DIR
 * (same convention as scripts/test-ticket-attachment-storage-integration.ts):
 *   - Ownership enforcement is BY INTEGRATION, not by department: a
 *     different integration, and even a same-department ticket the calling
 *     integration did NOT create, both get a generic 404.
 *   - A fresh upload with an externalAttachmentId persists correctly
 *     (TicketAttachment row, file on disk, TicketHistory ATTACHMENT_ADDED).
 *   - A retry with the SAME externalAttachmentId and IDENTICAL bytes is a
 *     true no-op (200, no second row, no second file) — content is
 *     re-verified from disk, not assumed from the key alone.
 *   - A retry with the SAME externalAttachmentId but DIFFERENT bytes is a
 *     hard 409 conflict — the original is never overwritten or duplicated.
 *   - TRUE CONCURRENCY: two simultaneous requests sharing a brand-new key
 *     (never seen before this exact pair of calls) still produce exactly
 *     one TicketAttachment row and one file — the advisory-lock-based
 *     serialization in integration-attachment-service.ts, not just a
 *     sequential read-before-insert check, is what's actually under test
 *     here.
 *   - Without an externalAttachmentId, no dedup is attempted at all (every
 *     call is a fresh attachment) — documented, deliberate behavior.
 *   - Oversized / disallowed-type / missing-file inputs are rejected with
 *     the same policy constants the WEB upload route enforces.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-integration-attachment-upload.ts
 * Requires a reachable DATABASE_URL and INTEGRATION_KEY_PEPPER.
 */
import os from "os";
import path from "path";
import fs from "fs/promises";
import { mock } from "node:test";
import { NextRequest } from "next/server";

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
const TAG = `iau-${RUN_ID}`;
const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), `${TAG}-uploads`);

async function main() {
  // Must be set before anything that imports lib/attachment-policy.ts
  // (UPLOAD_DIR is computed once at module load) is ever loaded — so every
  // route/service import below is dynamic, done only after this.
  process.env.UPLOAD_DIR = TEMP_UPLOAD_DIR;
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });

  // Same next/server after() stub as scripts/test-web-ticket-creation-
  // regression.ts / scripts/test-integration-tickets-api.ts — unrelated to
  // what this suite tests, required only because importing the sibling
  // ticket-creation route (used here purely to set up fixture tickets)
  // transitively reaches it.
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} },
  });

  const { prisma } = await import("@/lib/prisma");
  const { Prisma } = await import("@prisma/client");
  const { generateIntegrationKey } = await import("@/lib/services/integration-key-service");
  const { createTicketAtomic } = await import("@/lib/services/ticket-creation-service");
  const { ensureStatusForDepartment, STARTER_STATUSES } = await import("@/lib/services/config-starter-data");
  const { POST: attachmentPOST } = await import("@/app/api/integrations/tickets/[ticketId]/attachments/route");
  const { saveIntegrationTicketAttachment } = await import("@/lib/services/integration-attachment-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  if (!process.env.INTEGRATION_KEY_PEPPER) {
    console.log("INTEGRATION_KEY_PEPPER is not set — skipping.");
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const integrationIds: string[] = [];
  const userIds: string[] = [];
  const ticketIds: string[] = [];

  function uploadReq(ticketId: string, token: string | null, fields: Record<string, string | { bytes: number[]; filename: string; mime: string }>) {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "string") {
        fd.append(key, value);
      } else {
        fd.append(key, new Blob([new Uint8Array(value.bytes)], { type: value.mime }), value.filename);
      }
    }
    const headers: Record<string, string> = {};
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return new NextRequest(`http://localhost/api/integrations/tickets/${ticketId}/attachments`, { method: "POST", headers, body: fd as any });
  }

  async function call(ticketId: string, token: string | null, fields: Record<string, string | { bytes: number[]; filename: string; mime: string }>) {
    const res = await attachmentPOST(uploadReq(ticketId, token, fields), { params: Promise.resolve({ ticketId }) });
    const json = await res.json();
    return { status: res.status, json };
  }

  try {
    console.log("\nSetting up department/integrations/tickets...\n");

    const dept = await prisma.department.create({ data: { name: `${TAG}-dept`, slug: `${TAG}-dept` } });
    departmentIds.push(dept.id);
    const status = await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);

    const otherDept = await prisma.department.create({ data: { name: `${TAG}-other-dept`, slug: `${TAG}-other-dept` } });
    departmentIds.push(otherDept.id);
    await ensureStatusForDepartment(prisma, otherDept.id, STARTER_STATUSES[0]);

    const key1 = generateIntegrationKey();
    const integration1 = await prisma.externalIntegration.create({
      data: { name: `${TAG}-int-1`, slug: `${TAG}-int-1`, departmentId: dept.id, apiKeyPrefix: key1.keyPrefix, apiKeyHash: key1.keyHash },
    });
    integrationIds.push(integration1.id);

    // A SECOND integration, in a DIFFERENT department — for cross-
    // integration isolation.
    const key2 = generateIntegrationKey();
    const integration2 = await prisma.externalIntegration.create({
      data: { name: `${TAG}-int-2`, slug: `${TAG}-int-2`, departmentId: otherDept.id, apiKeyPrefix: key2.keyPrefix, apiKeyHash: key2.keyHash },
    });
    integrationIds.push(integration2.id);

    const requester1 = await prisma.user.create({ data: { email: `${TAG}-requester-1@example.com`, role: "USER", authProvider: "CREDENTIALS", passwordHash: "x", isActive: true } });
    userIds.push(requester1.id);

    // ticket1 — created BY integration1 (the ticket this whole suite uploads to).
    const ticket1 = await createTicketAtomic(
      { title: "Fixture ticket 1", description: "Owned by integration1.", source: "API", requesterId: requester1.id, statusId: status.id, departmentId: dept.id, integrationId: integration1.id, externalReferenceId: `${TAG}-ref-1` },
      { changedById: null, description: "Fixture" }
    );
    ticketIds.push(ticket1.id);

    // ticket2 — created BY integration2, in ITS OWN (different) department —
    // for the plain cross-integration check.
    const ticket2 = await createTicketAtomic(
      { title: "Fixture ticket 2", description: "Owned by integration2.", source: "API", requesterId: requester1.id, statusId: (await ensureStatusForDepartment(prisma, otherDept.id, STARTER_STATUSES[0])).id, departmentId: otherDept.id, integrationId: integration2.id, externalReferenceId: `${TAG}-ref-2` },
      { changedById: null, description: "Fixture" }
    );
    ticketIds.push(ticket2.id);

    // ticket3 — SAME department as integration1, but integrationId is null
    // (a plain WEB-sourced ticket) — proves department matching ALONE is
    // not the ownership check.
    const ticket3 = await createTicketAtomic(
      { title: "Fixture ticket 3 (WEB, same department)", description: "Not created by any integration.", source: "WEB", requesterId: requester1.id, statusId: status.id, departmentId: dept.id },
      { changedById: requester1.id, description: "Fixture" }
    );
    ticketIds.push(ticket3.id);

    const PNG_BYTES = [1, 2, 3, 4, 5, 6, 7, 8];
    const DIFFERENT_PNG_BYTES = [9, 9, 9, 9, 9, 9, 9, 9];

    // ── Ownership / auth ─────────────────────────────────────────────────
    console.log("\nTesting ownership and auth...\n");
    {
      const { status: s, json } = await call(ticket1.id, null, {});
      check("Missing Authorization -> 401 invalid_api_key", s === 401 && json.code === "invalid_api_key");
    }
    {
      const { status: s } = await call("not-a-real-ticket-id", key1.rawKey, { file: { bytes: PNG_BYTES, filename: "a.png", mime: "image/png" } });
      check("Nonexistent ticket id -> 404", s === 404);
    }
    {
      const { status: s } = await call(ticket1.id, key2.rawKey, { file: { bytes: PNG_BYTES, filename: "a.png", mime: "image/png" } });
      check("CROSS-INTEGRATION: integration2's key uploading to integration1's ticket -> 404 (not 403 — never confirms the ticket exists)", s === 404);
    }
    {
      const { status: s } = await call(ticket3.id, key1.rawKey, { file: { bytes: PNG_BYTES, filename: "a.png", mime: "image/png" } });
      check("SAME DEPARTMENT, DIFFERENT OWNER: integration1 uploading to a same-department WEB ticket it did not create -> 404 (department match alone is NOT sufficient)", s === 404);
    }

    // ── Fresh upload with an idempotency key ────────────────────────────
    console.log("\nTesting a fresh upload...\n");
    let firstAttachmentId = "";
    {
      const { status: s, json } = await call(ticket1.id, key1.rawKey, {
        file: { bytes: PNG_BYTES, filename: "evidence.png", mime: "image/png" },
        externalAttachmentId: `${TAG}-att-A`,
      });
      check("Fresh upload -> 201 created:true", s === 201 && json.created === true);
      check("Response has a structured attachment id/size/mimeType", typeof json.attachment?.id === "string" && json.attachment?.size === PNG_BYTES.length && json.attachment?.mimeType === "image/png");
      firstAttachmentId = json.attachment?.id;
    }
    const dbRowA = await prisma.ticketAttachment.findUnique({ where: { id: firstAttachmentId } });
    check("TicketAttachment row persisted with sourceAttachmentId set to the caller's key", dbRowA?.sourceAttachmentId === `${TAG}-att-A`);
    check("uploadedById is null (no human actor)", dbRowA?.uploadedById === null);
    const onDiskA = await fs.readFile(path.join(TEMP_UPLOAD_DIR, ticket1.id, dbRowA!.filename));
    check("File on disk matches uploaded bytes exactly", onDiskA.equals(Buffer.from(PNG_BYTES)));
    const historyCountAfterA = await prisma.ticketHistory.count({ where: { ticketId: ticket1.id, type: "ATTACHMENT_ADDED" } });
    check("Exactly one ATTACHMENT_ADDED TicketHistory row", historyCountAfterA === 1);
    const historyRowA = await prisma.ticketHistory.findFirst({ where: { ticketId: ticket1.id, type: "ATTACHMENT_ADDED" } });
    check("TicketHistory.changedById is null, description names the integration", historyRowA?.changedById === null && !!historyRowA?.description?.includes(integration1.name));

    // ── Idempotent retry: SAME key, IDENTICAL bytes ─────────────────────
    console.log("\nTesting idempotent retry (same key, same content)...\n");
    {
      const { status: s, json } = await call(ticket1.id, key1.rawKey, {
        file: { bytes: PNG_BYTES, filename: "evidence.png", mime: "image/png" },
        externalAttachmentId: `${TAG}-att-A`,
      });
      check("Identical retry -> 200 created:false, same attachment id", s === 200 && json.created === false && json.attachment?.id === firstAttachmentId);
    }
    const countAfterRetry = await prisma.ticketAttachment.count({ where: { ticketId: ticket1.id } });
    check("No second TicketAttachment row created by the identical retry", countAfterRetry === 1);
    const filesAfterRetry = await fs.readdir(path.join(TEMP_UPLOAD_DIR, ticket1.id));
    check("No second file written to disk by the identical retry", filesAfterRetry.length === 1);

    // ── Conflict: SAME key, DIFFERENT bytes ──────────────────────────────
    console.log("\nTesting conflict detection (same key, different content)...\n");
    {
      const { status: s, json } = await call(ticket1.id, key1.rawKey, {
        file: { bytes: DIFFERENT_PNG_BYTES, filename: "evidence.png", mime: "image/png" },
        externalAttachmentId: `${TAG}-att-A`,
      });
      check("Same key, different bytes -> 409 idempotency_conflict", s === 409 && json.code === "idempotency_conflict");
    }
    const countAfterConflict = await prisma.ticketAttachment.count({ where: { ticketId: ticket1.id } });
    check("The conflicting attempt created no new row", countAfterConflict === 1);
    const originalBytesStillIntact = await fs.readFile(path.join(TEMP_UPLOAD_DIR, ticket1.id, dbRowA!.filename));
    check("The original file was never overwritten by the conflicting attempt", originalBytesStillIntact.equals(Buffer.from(PNG_BYTES)));

    // ── TRUE CONCURRENCY: two simultaneous requests, brand-new key ──────
    console.log("\nTesting concurrent uploads sharing a brand-new key (identical content)...\n");
    {
      const raceKey = `${TAG}-att-race-same`;
      const body = { file: { bytes: PNG_BYTES, filename: "race.png", mime: "image/png" } as const, externalAttachmentId: raceKey };
      const [r1, r2] = await Promise.all([call(ticket1.id, key1.rawKey, body), call(ticket1.id, key1.rawKey, body)]);
      const statuses = [r1.status, r2.status].sort();
      check("Concurrent identical uploads -> one 201, one 200 (never two 201s)", statuses[0] === 200 && statuses[1] === 201);
      const ids = [r1.json.attachment?.id, r2.json.attachment?.id];
      check("Both responses reference the SAME single attachment", !!ids[0] && ids[0] === ids[1]);
      const raceCount = await prisma.ticketAttachment.count({ where: { ticketId: ticket1.id, sourceAttachmentId: raceKey } });
      check("Exactly one TicketAttachment row exists for the race key (the actual concurrency-safety proof)", raceCount === 1);
    }

    console.log("\nTesting concurrent uploads sharing a brand-new key (DIFFERENT content)...\n");
    {
      const raceKey = `${TAG}-att-race-diff`;
      const [r1, r2] = await Promise.all([
        call(ticket1.id, key1.rawKey, { file: { bytes: PNG_BYTES, filename: "race-a.png", mime: "image/png" }, externalAttachmentId: raceKey }),
        call(ticket1.id, key1.rawKey, { file: { bytes: DIFFERENT_PNG_BYTES, filename: "race-b.png", mime: "image/png" }, externalAttachmentId: raceKey }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      check("Concurrent CONFLICTING uploads -> one 201, one 409 (never two 201s, never silently merged)", statuses[0] === 201 && statuses[1] === 409);
      const raceCount = await prisma.ticketAttachment.count({ where: { ticketId: ticket1.id, sourceAttachmentId: raceKey } });
      check("Exactly one TicketAttachment row exists for the conflicting race key", raceCount === 1);
    }

    // ── Orphan-file compensation on a DEFINITIVE DB persistence failure ─
    console.log("\nTesting orphan-file cleanup when the DB write fails after a successful file write...\n");
    {
      // A nonexistent ticketId lets writeAttachmentFile succeed (it's pure
      // filesystem I/O, unaware of the DB) while forcing the subsequent
      // tx.ticketAttachment.create to fail on a real, deterministic FK
      // constraint violation — a genuine DB persistence failure, not a
      // mock, exercising the actual compensation path end to end.
      const orphanTicketId = `${TAG}-nonexistent-ticket`;
      const orphanKey = `${TAG}-att-orphan`;
      let threw = false;
      try {
        await saveIntegrationTicketAttachment({
          ticketId: orphanTicketId,
          buffer: Buffer.from(PNG_BYTES),
          originalName: "orphan.png",
          mimeType: "image/png",
          externalAttachmentId: orphanKey,
          integrationName: "Test",
        });
      } catch {
        threw = true;
      }
      check("A DB persistence failure (FK violation) propagates (never silently swallowed)", threw);
      const orphanDirFiles = await fs.readdir(path.join(TEMP_UPLOAD_DIR, orphanTicketId)).catch(() => []);
      check("No orphan file left on disk after the failed persistence attempt", orphanDirFiles.length === 0);
      const orphanRowCount = await prisma.ticketAttachment.count({ where: { sourceAttachmentId: orphanKey } });
      check("No TicketAttachment row was created by the failed attempt", orphanRowCount === 0);

      // Repeat the SAME failing call again — proves the leak is fully
      // closed (not merely reduced): each failed attempt must clean up
      // after itself, not just the first one.
      await saveIntegrationTicketAttachment({
        ticketId: orphanTicketId,
        buffer: Buffer.from(PNG_BYTES),
        originalName: "orphan.png",
        mimeType: "image/png",
        externalAttachmentId: orphanKey,
        integrationName: "Test",
      }).catch(() => {});
      const orphanDirFilesAfterSecondFailure = await fs.readdir(path.join(TEMP_UPLOAD_DIR, orphanTicketId)).catch(() => []);
      check("Still no orphan file after a SECOND failed attempt with the same key", orphanDirFilesAfterSecondFailure.length === 0);

      // Retry with the SAME externalAttachmentId but a VALID ticket —
      // proves the earlier failures left no residual state (no stuck
      // lock, no ghost row) that could block a legitimate subsequent call
      // using the same idempotency key.
      const retryResult = await saveIntegrationTicketAttachment({
        ticketId: ticket1.id,
        buffer: Buffer.from(PNG_BYTES),
        originalName: "orphan-retry.png",
        mimeType: "image/png",
        externalAttachmentId: orphanKey,
        integrationName: integration1.name,
      });
      check("A subsequent retry with the same key on a VALID ticket succeeds cleanly", retryResult.outcome === "created");
      // This whole block already exercises the GENUINE-ROLLBACK path of
      // the commit-ambiguity fix below (the nonexistent ticketId means
      // the catch block's own re-verification query correctly finds NO
      // row before deleting) — not merely the pre-fix behavior.
    }

    // ── Commit-ambiguity resolution: a rejected transaction promise does
    // NOT prove a rollback ──────────────────────────────────────────────
    console.log("\nTesting commit-ambiguity resolution (rejected promise after a REAL commit)...\n");
    {
      // simulateCommitAckLoss lets the transaction run to a REAL, genuine
      // commit (the file and DB row both actually persist), then fakes
      // only the "did the client get told it succeeded" step — exactly
      // modeling a dropped connection after the server processed COMMIT
      // but before the acknowledgment arrived. See this module's own doc
      // comment for why this can't be exercised via real network fault
      // injection in a focused test.
      const ackLossKey = `${TAG}-att-ack-loss`;
      const result = await saveIntegrationTicketAttachment(
        {
          ticketId: ticket1.id,
          buffer: Buffer.from(PNG_BYTES),
          originalName: "ack-loss.png",
          mimeType: "image/png",
          externalAttachmentId: ackLossKey,
          integrationName: integration1.name,
        },
        { simulateCommitAckLoss: true }
      );
      check("A commit whose acknowledgment was 'lost' still resolves as a successful 'created' result (never a false error)", result.outcome === "created");
      const rowCount = await prisma.ticketAttachment.count({ where: { ticketId: ticket1.id, sourceAttachmentId: ackLossKey } });
      check("Exactly ONE row exists (the real commit, recovered — not a duplicate)", rowCount === 1);
      if (result.outcome === "created") {
        const row = await prisma.ticketAttachment.findUnique({ where: { id: result.attachment.id } });
        const onDisk = row ? await fs.readFile(path.join(TEMP_UPLOAD_DIR, ticket1.id, row.filename)).catch(() => null) : null;
        check("The file was NEVER deleted despite the simulated ack loss", onDisk !== null && onDisk.equals(Buffer.from(PNG_BYTES)));
      }
    }
    {
      // When the verification query ITSELF cannot be trusted (e.g. the DB
      // is still unreachable right when the ambiguity check would run),
      // the correct behavior is to fail closed: never delete, and
      // propagate the ORIGINAL failure untouched (safe to retry either
      // way). Combined with the nonexistent-ticketId FK failure from the
      // block above so there's a real underlying failure to propagate.
      const unverifiableTicketId = `${TAG}-nonexistent-ticket-unverifiable`;
      const unverifiableKey = `${TAG}-att-unverifiable`;
      let threw = false;
      try {
        await saveIntegrationTicketAttachment(
          {
            ticketId: unverifiableTicketId,
            buffer: Buffer.from(PNG_BYTES),
            originalName: "unverifiable.png",
            mimeType: "image/png",
            externalAttachmentId: unverifiableKey,
            integrationName: "Test",
          },
          { simulateVerificationFailure: true }
        );
      } catch {
        threw = true;
      }
      check("The original failure still propagates when verification itself is unavailable", threw);
      const filesLeftBehind = await fs.readdir(path.join(TEMP_UPLOAD_DIR, unverifiableTicketId)).catch(() => []);
      check("FAILS CLOSED: the file is NOT deleted when the outcome can't be verified (a leaked file, never a wrongly-deleted one)", filesLeftBehind.length === 1);
      const rowCount = await prisma.ticketAttachment.count({ where: { sourceAttachmentId: unverifiableKey } });
      check("No row was created either (the underlying failure was real, just unverifiable)", rowCount === 0);
    }

    // ── No idempotency key supplied: no dedup attempted ─────────────────
    console.log("\nTesting uploads with no externalAttachmentId (no dedup promised)...\n");
    {
      const r1 = await call(ticket1.id, key1.rawKey, { file: { bytes: PNG_BYTES, filename: "no-key.png", mime: "image/png" } });
      const r2 = await call(ticket1.id, key1.rawKey, { file: { bytes: PNG_BYTES, filename: "no-key.png", mime: "image/png" } });
      check("Both unkeyed uploads succeed as 201 (each is a fresh attachment)", r1.status === 201 && r2.status === 201 && r1.json.attachment?.id !== r2.json.attachment?.id);
    }

    // ── Invalid input ─────────────────────────────────────────────────────
    console.log("\nTesting invalid input...\n");
    {
      const { status: s, json } = await call(ticket1.id, key1.rawKey, {});
      check("Missing file field -> 400", s === 400 && json.code === "validation_failed");
    }
    {
      const oversized = new Array(10 * 1024 * 1024 + 1).fill(7);
      const { status: s } = await call(ticket1.id, key1.rawKey, { file: { bytes: oversized, filename: "huge.png", mime: "image/png" } });
      check("Oversized file (>10MB) -> 413", s === 413);
    }
    {
      const { status: s, json } = await call(ticket1.id, key1.rawKey, { file: { bytes: [1, 2, 3], filename: "script.exe", mime: "application/x-msdownload" } });
      check("Disallowed MIME type -> 422", s === 422 && json.code === "validation_failed");
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      console.log("Prisma error:", err.code, err.message);
    } else {
      console.log("Unexpected error:", err instanceof Error ? err.stack : err);
    }
    failed++;
  } finally {
    console.log("\nCleaning up test data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["integrations", () => prisma.externalIntegration.deleteMany({ where: { id: { in: integrationIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await fs.rm(TEMP_UPLOAD_DIR, { recursive: true, force: true }).catch(() => {});
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
