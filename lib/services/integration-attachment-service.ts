/**
 * Idempotent, concurrency-safe attachment ingestion for the AI Agent /
 * external-integration attachment endpoint (POST /api/integrations/tickets/
 * [ticketId]/attachments). Shares the exact same durable write path as
 * every other attachment ingestion route (lib/attachment-storage-service.ts's
 * writeAttachmentFile) — this module adds ONLY the idempotency layer on
 * top, it never re-implements storage.
 *
 * IDEMPOTENCY KEY: reuses TicketAttachment.sourceAttachmentId (already used
 * by Graph-email ingestion for the identical purpose — "has this exact
 * external attachment already been saved for this parent"). No schema
 * migration. Scoped by ticketId here (the email paths scope by messageId
 * instead) since an integration-posted attachment has no TicketMessage of
 * its own.
 *
 * WHY A PLAIN "FIND THEN INSERT" IS NOT ENOUGH: unlike the email ingestion
 * paths (which are driven by a single sequential poller, so two calls with
 * the same sourceAttachmentId are never truly concurrent), an external
 * caller over HTTP can genuinely send two requests with the same
 * externalAttachmentId at the same instant (a naive retry-on-timeout, or a
 * duplicate webhook delivery). sourceAttachmentId has deliberately no
 * unique constraint (see its doc comment in prisma/schema.prisma), so two
 * concurrent "does a row with this key already exist? no -> insert" checks
 * could both observe "not found" and both insert, producing two
 * TicketAttachment rows for one logical upload. Adding a real unique
 * constraint would fix this but requires a migration — out of scope for
 * this change (see the architecture review this module implements).
 *
 * THE FIX, WITHOUT A MIGRATION: a PostgreSQL session/transaction advisory
 * lock (pg_advisory_xact_lock), keyed by (ticketId, externalAttachmentId),
 * held for the lifetime of one Prisma interactive transaction. Two calls
 * sharing the same key are forced to run one at a time — the second only
 * acquires the lock (and only then runs its own existence check) after the
 * first has fully committed (or rolled back). This is a real mutual-
 * exclusion primitive, not a best-effort check — it is exactly as safe as
 * a unique constraint for this purpose, just without altering the schema.
 * The lock key itself is hashed (Postgres hashtext, 32 bits per argument)
 * — a hash collision between two UNRELATED keys only costs extra, harmless
 * serialization (two unrelated uploads briefly queue behind each other);
 * the actual duplicate decision below is always made from the real
 * (ticketId, sourceAttachmentId) values, never from the hash, so a
 * collision can never cause an incorrect result.
 *
 * CONTENT-MISMATCH DETECTION ON RETRY: when a row for the same key already
 * exists, the existing file is re-read from disk and SHA-256-compared
 * against the newly received bytes — not just size/mimeType/name. A
 * genuine retry (identical bytes) is a silent, zero-write no-op returning
 * the original row ("duplicate"). A SAME key with DIFFERENT bytes is a
 * hard "conflict" — the original attachment is never overwritten or
 * duplicated. No new DB column is needed for this: the comparison is
 * computed on demand from the already-durable file, the same thing
 * writeAttachmentFile itself verifies against immediately after writing.
 *
 * Deliberately holds the DB transaction open across the filesystem write
 * on the "first time for this key" path (inside writeAttachmentFile) — an
 * uncommon thing to do, but required here: the advisory lock is scoped to
 * the transaction's lifetime (xact, not session), so releasing it before
 * the write would reopen the exact race this module exists to close.
 * Files are capped at MAX_ATTACHMENT_SIZE_BYTES and this is a
 * machine-to-machine integration path (not the primary interactive UI
 * upload), so the extra connection-hold time is an acceptable, deliberate
 * trade-off for correctness.
 *
 * ORPHAN-FILE COMPENSATION ON DB FAILURE: if the file write succeeds but
 * the subsequent TicketAttachment/TicketHistory inserts fail (a dropped
 * connection, a transient DB error), the written file must not be left
 * behind with no referencing row. The compensating fs.unlink deliberately
 * runs OUTSIDE prisma.$transaction's callback — in the outer catch below,
 * after `await prisma.$transaction(...)` has itself thrown — never inside
 * the callback's own try/catch, so nothing is deleted while the
 * transaction's own fate is still being decided by Prisma's internals.
 * `pendingWrite` is set the moment a write durably lands (before any DB
 * statement runs) and is read only by that outer catch — same WEB-upload-
 * route compensation convention (see app/api/tickets/[id]/attachments/
 * route.ts), just moved to the point where the transaction has settled.
 *
 * A REJECTED PROMISE DOES NOT PROVE A ROLLBACK, THOUGH: PostgreSQL can
 * execute and durably commit a COMMIT before the acknowledgment reaches
 * the client — if the connection drops in that exact window, Prisma's
 * `$transaction` promise rejects exactly as it would for a genuine
 * rollback, even though the write actually committed. Deleting the file
 * on that assumption would recreate, via a different path, the original
 * production incident this module's whole safety layer exists to
 * prevent (a committed row with no backing file) — just inverted (a
 * backing file deleted out from under a committed row). The outer catch
 * below therefore never deletes on the mere fact of a rejection: it
 * re-queries by (ticketId, filename) — filename is unique per call
 * (generateStoredFilename uses randomUUID()) — to authoritatively learn
 * whether this exact write actually committed, using the SAME
 * read+hash verification already used above for retry-content
 * comparison, before deciding anything. See the three outcomes
 * documented on saveIntegrationTicketAttachment's catch block itself.
 */
import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { UPLOAD_DIR, generateStoredFilename, isSafeStoredFilename, resolvesInsideDir } from "@/lib/attachment-policy";
import { writeAttachmentFile } from "@/lib/attachment-storage-service";
import { publishTicketListInvalidationInTransaction } from "@/lib/realtime/ticket-list-invalidation";

type Db = typeof prisma | Prisma.TransactionClient;

export interface IntegrationAttachmentInput {
  ticketId: string;
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  /** Caller's own idempotency key for this one attachment, or null if the caller didn't supply one (then no dedup is attempted — every call writes a new attachment). */
  externalAttachmentId: string | null;
  /** For the TicketHistory description only — never trusted for authorization (that's already been checked by the route before this is called). */
  integrationName: string;
}

export interface StructuredAttachmentResult {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export type IntegrationAttachmentResult =
  | { outcome: "created"; attachment: StructuredAttachmentResult }
  | { outcome: "duplicate"; attachment: StructuredAttachmentResult }
  | { outcome: "conflict" }
  | { outcome: "error"; statusCode: 503 | 409 | 500; reason: string };

function toStructuredResult(attachment: { id: string; originalName: string; mimeType: string; size: number; createdAt: Date }): StructuredAttachmentResult {
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt.toISOString(),
  };
}

async function readExistingAttachmentBytes(ticketId: string, filename: string): Promise<Buffer | null> {
  if (!isSafeStoredFilename(filename)) return null;
  const filePath = path.join(UPLOAD_DIR, ticketId, filename);
  if (!resolvesInsideDir(filePath, path.join(UPLOAD_DIR, ticketId))) return null;
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function createFreshAttachment(
  tx: Db,
  input: IntegrationAttachmentInput,
  onDurableWrite: (write: { dir: string; filename: string }) => void
): Promise<IntegrationAttachmentResult> {
  const dir = path.join(UPLOAD_DIR, input.ticketId);
  const filename = generateStoredFilename(input.originalName);

  const writeResult = await writeAttachmentFile(input.buffer, dir, filename);
  if (!writeResult.ok) {
    return { outcome: "error", statusCode: writeResult.statusCode, reason: writeResult.reason };
  }
  // Recorded BEFORE any DB statement runs — if anything below throws, the
  // caller's outer catch (after this whole transaction has definitively
  // failed, never from inside this callback) knows exactly what to clean
  // up. See this module's top doc comment ("ORPHAN-FILE COMPENSATION").
  onDurableWrite({ dir, filename });

  const attachment = await tx.ticketAttachment.create({
    data: {
      ticketId: input.ticketId,
      uploadedById: null,
      filename,
      originalName: input.originalName,
      mimeType: input.mimeType,
      size: writeResult.size,
      path: `/uploads/${input.ticketId}/${filename}`,
      sourceAttachmentId: input.externalAttachmentId,
    },
  });

  await tx.ticketHistory.create({
    data: {
      ticketId: input.ticketId,
      changedById: null,
      type: "ATTACHMENT_ADDED",
      description: `Attachment "${input.originalName}" uploaded through integration ${input.integrationName}`,
      newValue: input.originalName,
    },
  });

  // publishTicketListInvalidationInTransaction requires a real
  // Prisma.TransactionClient (it issues raw SQL) — both call sites below
  // always invoke createFreshAttachment from inside prisma.$transaction, so
  // tx is never the bare top-level client in practice; the signature is
  // widened to Db only so this function can also run standalone in tests.
  await publishTicketListInvalidationInTransaction(tx as Prisma.TransactionClient);

  return { outcome: "created", attachment: toStructuredResult(attachment) };
}

/**
 * `deps` is a TEST SEAM ONLY (both flags default to false/off; neither
 * route ever passes this argument) — see scripts/test-integration-
 * attachment-upload.ts's commit-ambiguity tests. Simulating a real
 * dropped-connection-after-commit requires fault injection below the
 * Postgres wire protocol, which isn't practical to exercise in a focused
 * test; these flags instead let a test deterministically force the exact
 * two scenarios the catch block below must resolve correctly, without
 * ever bypassing real transaction/commit/verification behavior:
 *   - `simulateCommitAckLoss`: after a transaction has ALREADY genuinely
 *     committed a fresh write, throws instead of returning normally —
 *     i.e., the DB-side outcome is completely real, only the "did the
 *     client get told it succeeded" step is faked.
 *   - `simulateVerificationFailure`: makes the catch block's own
 *     re-verification query fail, independent of real DB reachability.
 */
export interface SaveIntegrationTicketAttachmentTestDeps {
  simulateCommitAckLoss?: boolean;
  simulateVerificationFailure?: boolean;
}

export async function saveIntegrationTicketAttachment(
  input: IntegrationAttachmentInput,
  deps?: SaveIntegrationTicketAttachmentTestDeps
): Promise<IntegrationAttachmentResult> {
  // Set the instant writeAttachmentFile durably publishes a file, cleared
  // never — only ever READ below, in the outer catch, and only once the
  // whole transaction has definitively failed. On success this is simply
  // never consulted. See "ORPHAN-FILE COMPENSATION" in this module's top
  // doc comment for why this must not be handled from inside the
  // transaction callback itself.
  type DurableWrite = { dir: string; filename: string };
  // A one-slot mutable box, not a bare `let` — TS's control-flow narrowing
  // cannot see through the onDurableWrite closure's assignment (it only
  // runs inside a separate prisma.$transaction callback), so a plain `let`
  // gets narrowed to `null` by the time the catch block below reads it.
  // Reading/writing a property on a stable object reference sidesteps
  // that entirely.
  const pendingWriteBox: { current: DurableWrite | null } = { current: null };
  const onDurableWrite = (write: DurableWrite) => {
    pendingWriteBox.current = write;
  };

  try {
    let result: IntegrationAttachmentResult;
    if (!input.externalAttachmentId) {
      // No idempotency key supplied — the caller gets no dedup guarantee,
      // exactly as documented; every call is a fresh attachment, same as
      // the WEB upload route's own (unkeyed) behavior.
      result = await prisma.$transaction((tx) => createFreshAttachment(tx, input, onDurableWrite));
    } else {
      const ticketId = input.ticketId;
      const key = input.externalAttachmentId;

      result = await prisma.$transaction(async (tx) => {
        // Mutual exclusion for this exact (ticketId, externalAttachmentId)
        // pair — see this module's top doc comment. Released automatically
        // when this transaction commits or rolls back (xact-scoped, not
        // session-scoped), so it can never be left held by a crashed request.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ticketId}), hashtext(${key}))`;

        const existing = await tx.ticketAttachment.findFirst({
          where: { ticketId, sourceAttachmentId: key },
        });

        if (existing) {
          const existingBytes = await readExistingAttachmentBytes(ticketId, existing.filename);
          if (existingBytes === null) {
            return {
              outcome: "error",
              statusCode: 500,
              reason: "An attachment record for this externalAttachmentId already exists, but its file could not be read back to verify this is a genuine retry.",
            } as IntegrationAttachmentResult;
          }
          const same = existingBytes.length === input.buffer.length && sha256(existingBytes) === sha256(input.buffer);
          if (same) {
            return { outcome: "duplicate", attachment: toStructuredResult(existing) } as IntegrationAttachmentResult;
          }
          return { outcome: "conflict" } as IntegrationAttachmentResult;
        }

        return createFreshAttachment(tx, input, onDurableWrite);
      });
    }

    if (deps?.simulateCommitAckLoss && result.outcome === "created") {
      // TEST SEAM ONLY — see this function's doc comment. The transaction
      // above has ALREADY genuinely committed; this only fakes losing the
      // acknowledgment of that real commit.
      throw new Error("[test] simulated commit-acknowledgment loss");
    }
    return result;
  } catch (err) {
    const write = pendingWriteBox.current;
    if (write) {
      // The transaction's promise rejected, but that alone does not tell
      // us whether it actually committed (see this module's top doc
      // comment) — authoritatively check by re-querying for a row
      // referencing EXACTLY this file, rather than assuming either
      // outcome. This query, and everything inside this try, can itself
      // fail (e.g. the DB is still unreachable) — any failure here
      // leaves `committedRow` unresolved and the catch below ensures
      // nothing is deleted in that case either.
      try {
        if (deps?.simulateVerificationFailure) {
          // TEST SEAM ONLY — see this function's doc comment.
          throw new Error("[test] simulated DB verification failure");
        }
        const committedRow = await prisma.ticketAttachment.findFirst({
          where: { ticketId: input.ticketId, filename: write.filename },
        });

        if (committedRow) {
          // OUTCOME 1 — it actually committed: the rejection was a lost
          // commit acknowledgment, not a real failure. Never delete a
          // file a real row references. Re-verify the file itself is
          // still present and byte-identical to what this call wrote
          // (never trust the row alone) using the SAME storage
          // verification already used above for retry-content
          // comparison (readExistingAttachmentBytes + sha256).
          const committedBytes = await readExistingAttachmentBytes(input.ticketId, committedRow.filename);
          const consistent =
            committedBytes !== null && committedBytes.length === input.buffer.length && sha256(committedBytes) === sha256(input.buffer);
          if (consistent) {
            return { outcome: "created", attachment: toStructuredResult(committedRow) };
          }
          // The row is real but the file can't be verified as present
          // and consistent — fail closed with a controlled error rather
          // than either deleting (the row might still need it) or
          // falsely reporting success.
          return {
            outcome: "error",
            statusCode: 500,
            reason: "The attachment record was persisted, but its file could not be verified as present and consistent on disk.",
          };
        }

        // OUTCOME 2 — confirmed: no row exists for this exact file, a
        // genuine, confirmed rollback. Safe to clean up using the same
        // swallow-errors cleanup already used by the WEB upload route's
        // own compensation (app/api/tickets/[id]/attachments/route.ts).
        await fs.unlink(path.join(write.dir, write.filename)).catch(() => {});
      } catch {
        // OUTCOME 3 — the verification query itself failed: the real
        // outcome remains genuinely unknown. Fail closed — never delete
        // on an unresolved ambiguity. A leaked file is a small,
        // recoverable cost; deleting one a committed row might
        // reference is not. Falls through to the original error below,
        // which is always safe to retry: if it actually committed, a
        // later retry with the same externalAttachmentId finds it and
        // returns "duplicate"; if it didn't, a later retry creates it
        // fresh.
      }
    }
    throw err;
  }
}
