/**
 * Durable, delayed reminder for an APPROVED Project Request that still has
 * no Project set up — see ProjectRequestSetupReminder's own doc comment in
 * schema.prisma for the full design rationale (one row per request, fires
 * once, notifies every CURRENTLY eligible approver for the department, not
 * a fixed recipient).
 *
 * State machine (same shape as lib/services/mention-reminder-service.ts,
 * minus the RESPONDED state — there's no "did they respond" concept here,
 * only "was the Project set up or not"):
 *   PENDING -> PROCESSING (claim: dueAt-eligible rows, FOR UPDATE SKIP LOCKED + claimToken)
 *   PROCESSING -> SENT | CANCELLED (only with the matching token)
 *   PENDING/PROCESSING -> CANCELLED (Project created — see cancelSetupReminderInTx)
 *   stale PROCESSING (claimedAt older than STALE_CLAIM_TIMEOUT_MS) is re-claimable.
 * The SENT transition and the per-recipient Notification fan-out are not in
 * the SAME transaction (unlike mention reminders' single-recipient case) —
 * fanning out to N recipients inside one DB transaction would hold the row
 * lock for N notification.create calls; instead the SENT transition commits
 * first (the real exactly-once guarantee — a retry/second worker fails the
 * token-guarded update and never reaches the fan-out at all), then
 * createInAppNotification is called per recipient after commit, same
 * "transactional state change now, best-effort delivery after" split
 * dispatchCreatedNotification already uses everywhere else in this codebase.
 */
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { addMonths } from "date-fns";
import { prisma } from "@/lib/prisma";
import { createInAppNotification } from "@/lib/notifications/create-notification";
import { getEligibleApproverUserIds } from "@/lib/services/project-request-approver-eligibility-service";

export const SETUP_REMINDER_DELAY_MONTHS = 1;
export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCHES_PER_RUN = 10;
/** A PROCESSING claim older than this is considered abandoned by a crashed worker and becomes re-claimable. */
export const STALE_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

export function setupReminderTitle(): string {
  return "Project Request still needs Project setup";
}
export function setupReminderBody(title: string): string {
  return `"${title}" was approved over a month ago and still has no Project set up.`;
}
export function setupReminderLink(requestId: string): string {
  return `/project-requests/${requestId}`;
}

type Db = Prisma.TransactionClient | typeof prisma;

// ─── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Inside decideApproval's own transaction, right after a request is moved to
 * APPROVED — one reminder, due SETUP_REMINDER_DELAY_MONTHS after `approvedAt`
 * (the same moment this transaction is committing). `projectRequestId`'s own
 * `@unique` constraint makes this idempotent against a concurrent duplicate
 * approval attempt the same way mention reminders' skipDuplicates does — a
 * plain `create` is enough here since decideApproval's own guarded
 * `updateMany` (status: PENDING_APPROVAL) already ensures this only runs
 * once per real approval event.
 */
export async function scheduleSetupReminderInTx(tx: Db, requestId: string, approvedAt: Date): Promise<void> {
  await tx.projectRequestSetupReminder.create({
    data: { projectRequestId: requestId, dueAt: addMonths(approvedAt, SETUP_REMINDER_DELAY_MONTHS) },
  });
}

/**
 * Inside createProjectFromApprovedRequest's own transaction, right after a
 * REAL (never alreadyExisted) Project is created — the request no longer
 * needs reminding. Cancels PENDING or PROCESSING (a worker may already hold
 * the claim; clearing the claim fields makes that worker's token-guarded
 * finalization a no-op, same pattern resolveRespondedRemindersInTx uses).
 * A no-op (0 rows) if no reminder exists (pre-feature request, or Project
 * created before this feature shipped) or it's already SENT/CANCELLED.
 */
export async function cancelSetupReminderInTx(tx: Db, requestId: string, reason: string, now: Date): Promise<void> {
  await tx.projectRequestSetupReminder.updateMany({
    where: { projectRequestId: requestId, status: { in: ["PENDING", "PROCESSING"] } },
    data: { status: "CANCELLED", cancelledAt: now, cancellationReason: reason, claimedAt: null, claimToken: null },
  });
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export interface ProcessResult {
  claimed: number;
  sent: number;
  cancelled: number;
  failed: number;
}

export interface ProcessOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  staleAfterMs?: number;
}

async function claimBatch(now: Date, batchSize: number, staleAfterMs: number): Promise<{ id: string; token: string }[]> {
  const token = randomUUID();
  const nowUtc = now.toISOString();
  const staleBeforeUtc = new Date(now.getTime() - staleAfterMs).toISOString();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "ProjectRequestSetupReminder"
    SET status = 'PROCESSING', "claimedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC'), "claimToken" = ${token}, "updatedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC')
    WHERE id IN (
      SELECT id FROM "ProjectRequestSetupReminder"
      WHERE (status = 'PENDING' AND "dueAt" <= (${nowUtc}::timestamptz AT TIME ZONE 'UTC'))
         OR (status = 'PROCESSING' AND "claimedAt" < (${staleBeforeUtc}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "dueAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => ({ id: r.id, token }));
}

export type Outcome = "sent" | "cancelled" | "lost_claim";

async function finalize(id: string, token: string, data: Prisma.ProjectRequestSetupReminderUpdateManyMutationInput, now: Date): Promise<boolean> {
  const r = await prisma.projectRequestSetupReminder.updateMany({ where: { id, status: "PROCESSING", claimToken: token }, data: { ...data, claimToken: null, updatedAt: now } });
  return r.count === 1;
}

export interface ProcessHooks {
  /** Test seam only: runs after every pre-check, immediately before the final SENT-transition transaction — lets a test commit a competing write at exactly that point. */
  beforeFinalTransaction?: () => Promise<void>;
}

/** Processes ONE already-claimed reminder (the caller holds `token`). Exported so tests can drive the claim/finalize ordering deterministically. */
export async function processClaimedSetupReminder(id: string, token: string, now: Date, hooks: ProcessHooks = {}): Promise<Outcome> {
  return processOne(id, token, now, hooks);
}

async function processOne(id: string, token: string, now: Date, hooks: ProcessHooks = {}): Promise<Outcome> {
  const reminder = await prisma.projectRequestSetupReminder.findUnique({
    where: { id },
    include: { projectRequest: { select: { id: true, title: true, status: true, departmentId: true, project: { select: { id: true } } } } },
  });
  if (!reminder || reminder.status !== "PROCESSING" || reminder.claimToken !== token) return "lost_claim";

  const request = reminder.projectRequest;
  const cancel = async (reason: string): Promise<Outcome> =>
    (await finalize(id, token, { status: "CANCELLED", cancelledAt: now, cancellationReason: reason }, now)) ? "cancelled" : "lost_claim";

  if (!request) return cancel("source_missing");
  // Defense in depth against a Project created after scheduling but before
  // cancelSetupReminderInTx's own cancellation landed (a genuine race, or a
  // request that predates this feature and already has a Project).
  if (request.project) return cancel("already_set_up");
  if (request.status !== "APPROVED") return cancel("status_changed");

  const recipientIds = await getEligibleApproverUserIds(request.departmentId);
  if (recipientIds.length === 0) return cancel("no_eligible_recipients");

  await hooks.beforeFinalTransaction?.();

  // Exactly-once SENT transition — the row lock taken by this guarded
  // update serializes against a concurrent cancelSetupReminderInTx (Project
  // just got created), re-checked one last time inside the lock.
  const finalResult = await prisma.$transaction(async (tx) => {
    const moved = await tx.projectRequestSetupReminder.updateMany({
      where: { id, status: "PROCESSING", claimToken: token },
      data: { status: "SENT", sentAt: now, claimedAt: null, claimToken: null },
    });
    if (moved.count !== 1) return { kind: "lost" as const };
    const stillUnset = await tx.projectRequest.findUnique({ where: { id: request.id }, select: { project: { select: { id: true } } } });
    if (stillUnset?.project) {
      await tx.projectRequestSetupReminder.update({ where: { id }, data: { status: "CANCELLED", sentAt: null, cancelledAt: now, cancellationReason: "already_set_up" } });
      return { kind: "cancelled" as const };
    }
    return { kind: "sent" as const };
  });
  if (finalResult.kind === "lost") return "lost_claim";
  if (finalResult.kind === "cancelled") return "cancelled";

  // Fan-out AFTER commit — same split as notifyEligibleApproversOfSubmission
  // (project-request-service.ts) and dispatchCreatedNotification generally;
  // the state transition above is already the real exactly-once guarantee,
  // so a failure here (or a crash mid-fan-out) is a delivery concern only,
  // never re-triggers the whole reminder.
  await Promise.all(
    recipientIds.map((userId) =>
      createInAppNotification({
        userId,
        title: setupReminderTitle(),
        body: setupReminderBody(request.title),
        link: setupReminderLink(request.id),
      })
    )
  );
  return "sent";
}

export async function processDueProjectRequestSetupReminders(options: ProcessOptions = {}): Promise<ProcessResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_RUN;
  const staleAfterMs = options.staleAfterMs ?? STALE_CLAIM_TIMEOUT_MS;
  const result: ProcessResult = { claimed: 0, sent: 0, cancelled: 0, failed: 0 };

  for (let i = 0; i < maxBatches; i++) {
    const batch = await claimBatch(now, batchSize, staleAfterMs);
    result.claimed += batch.length;
    for (const { id, token } of batch) {
      try {
        const outcome = await processOne(id, token, now);
        if (outcome === "sent") result.sent++;
        else if (outcome === "cancelled") result.cancelled++;
      } catch (err) {
        // Left PROCESSING: recoverable after STALE_CLAIM_TIMEOUT_MS.
        result.failed++;
        console.error(`[project-request-setup-reminders] reminder ${id} failed:`, err instanceof Error ? err.name : "unknown");
      }
    }
    if (batch.length < batchSize) break;
  }
  console.info(`[project-request-setup-reminders] run at ${now.toISOString()}: claimed=${result.claimed} sent=${result.sent} cancelled=${result.cancelled} failed=${result.failed}`);
  return result;
}
