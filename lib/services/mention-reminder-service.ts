/**
 * Durable Mention Reminders for structured @mentions in Project Notes and
 * Activity Notes (never Ticket Internal Notes — TicketMessageMention has no
 * reminder relation at all).
 *
 * "Responded" = a NEWER Note authored by the mentioned user on the SAME
 * Project/Activity (created after the mention). Notes are not threaded, so
 * nothing else can count: another user's Note, or a Note on another entity,
 * never resolves a reminder; one response resolves every earlier pending
 * reminder for that user on that entity.
 *
 * State machine (all transitions are guarded UPDATEs, never process-local):
 *   PENDING -> PROCESSING (claim: FOR UPDATE SKIP LOCKED + claimToken)
 *   PROCESSING -> SENT | RESPONDED | CANCELLED (only with the matching token)
 *   PENDING -> RESPONDED (a Note by the user) | CANCELLED (opt-out)
 *   stale PROCESSING (claimedAt older than STALE_CLAIM_TIMEOUT_MS) is re-claimable.
 * SENT is committed in the SAME transaction as the Notification row, so a
 * retry/second worker can never create a second Notification; realtime + Web
 * Push run after commit through the existing dispatchCreatedNotification.
 */
import { randomUUID } from "crypto";
import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { dispatchCreatedNotification } from "@/lib/notifications/create-notification";
import {
  DEFAULT_MENTION_REMINDER_DELAY_MINUTES,
  parseMentionReminderDelay,
} from "@/lib/mention-reminders/config";

export type ReminderEntityType = "project" | "activity";

const VIEW_KEY = { project: "project.view", activity: "activity.view" } as const;
/** The permission that lets a user create a Note on that entity — the same key the Note-create routes enforce. */
const NOTE_KEY = { project: "project.edit", activity: "activity.edit" } as const;

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCHES_PER_RUN = 10;
/** A PROCESSING claim older than this is considered abandoned by a crashed worker and becomes re-claimable. */
export const STALE_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;

export const REMINDER_TITLE = "Mention reminder";
export function reminderBody(entityType: ReminderEntityType, title: string): string {
  return `You were mentioned in ${entityType === "project" ? "project" : "activity"} "${title}" and have not responded yet.`;
}
export function reminderLink(entityType: ReminderEntityType, entityId: string): string {
  return `/${entityType === "project" ? "projects" : "activities"}/${entityId}#notes`;
}

type Db = Prisma.TransactionClient | typeof prisma;

// ─── Admin-configured delay ───────────────────────────────────────────────────

export async function getMentionReminderDelayMinutes(db: Db = prisma): Promise<number> {
  const row = await db.mentionReminderSettings.findUnique({ where: { id: "default" } });
  return row?.delayMinutes ?? DEFAULT_MENTION_REMINDER_DELAY_MINUTES;
}

/**
 * Persists the new delay and recalculates every unsent PENDING reminder from
 * its ORIGINAL mention time. Never delivers anything itself — a newly overdue
 * reminder simply becomes eligible for the next worker run. SENT / RESPONDED /
 * CANCELLED / PROCESSING rows are never touched.
 */
export async function updateMentionReminderDelay(minutes: number, updatedById: string | null): Promise<{ recalculated: number }> {
  const parsed = parseMentionReminderDelay(minutes, "minutes");
  if (!parsed.ok) throw new Error(parsed.error);
  return prisma.$transaction(async (tx) => {
    await tx.mentionReminderSettings.upsert({
      where: { id: "default" },
      create: { id: "default", delayMinutes: minutes, updatedById },
      update: { delayMinutes: minutes, updatedById },
    });
    const a = await tx.$executeRaw`
      UPDATE "MentionReminder" r
      SET "dueAt" = m."createdAt" + make_interval(mins => ${minutes}::int), "updatedAt" = (now() AT TIME ZONE 'UTC')
      FROM "ProjectNoteMention" m
      WHERE r."projectNoteMentionId" = m.id AND r.status = 'PENDING'`;
    const b = await tx.$executeRaw`
      UPDATE "MentionReminder" r
      SET "dueAt" = m."createdAt" + make_interval(mins => ${minutes}::int), "updatedAt" = (now() AT TIME ZONE 'UTC')
      FROM "ActivityNoteMention" m
      WHERE r."activityNoteMentionId" = m.id AND r.status = 'PENDING'`;
    return { recalculated: Number(a) + Number(b) };
  });
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Which of the already-validated, already-persisted mentioned users should get
 * a reminder: not the author, active, reminders enabled, and — against the
 * REAL entity department, never the active workspace — able to view the entity
 * AND to create a Note there. Intentionally narrower than mention eligibility:
 * a view-only user is mentioned (and notified immediately) but never reminded.
 */
export async function filterReminderEligibleUserIds(params: {
  entityType: ReminderEntityType;
  entityDepartmentId: string | null;
  authorId: string;
  mentionedUserIds: string[];
}): Promise<string[]> {
  const ids = Array.from(new Set(params.mentionedUserIds)).filter((id) => id !== params.authorId);
  if (ids.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, isActive: true, mentionRemindersEnabled: true },
    select: { id: true, role: true, customRoleId: true },
  });
  const eligible: string[] = [];
  for (const u of users) {
    if (await userCanViewAndNote(u, params.entityType, params.entityDepartmentId)) eligible.push(u.id);
  }
  return eligible;
}

async function userCanViewAndNote(
  u: { id: string; role: Role; customRoleId: string | null },
  entityType: ReminderEntityType,
  departmentId: string | null
): Promise<boolean> {
  if (!(await hasEffectiveEntityPermission(u.id, u.role, u.customRoleId, departmentId, VIEW_KEY[entityType]))) return false;
  if (!(await hasEffectiveEntityPermission(u.id, u.role, u.customRoleId, departmentId, NOTE_KEY[entityType]))) return false;
  return true;
}

/**
 * Inside the Note-create transaction, right after the mention rows exist:
 * one reminder per eligible mention, dueAt = mention.createdAt + configured
 * delay. skipDuplicates + the unique source FKs make this idempotent.
 */
export async function scheduleMentionRemindersInTx(
  tx: Prisma.TransactionClient,
  params: { entityType: ReminderEntityType; noteId: string; eligibleUserIds: string[] }
): Promise<number> {
  if (params.eligibleUserIds.length === 0) return 0;
  const delay = await getMentionReminderDelayMinutes(tx);
  const rows =
    params.entityType === "project"
      ? await tx.projectNoteMention.findMany({ where: { noteId: params.noteId, userId: { in: params.eligibleUserIds } }, select: { id: true, createdAt: true } })
      : await tx.activityNoteMention.findMany({ where: { noteId: params.noteId, userId: { in: params.eligibleUserIds } }, select: { id: true, createdAt: true } });
  if (rows.length === 0) return 0;
  const result = await tx.mentionReminder.createMany({
    data: rows.map((m) => ({
      ...(params.entityType === "project" ? { projectNoteMentionId: m.id } : { activityNoteMentionId: m.id }),
      dueAt: new Date(m.createdAt.getTime() + delay * 60_000),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Inside the Note-create transaction: the author just responded on this
 * entity, so every still-PENDING or claimed (PROCESSING) reminder for THIS user on THIS entity whose
 * mention predates the Note is RESPONDED. Nothing else (other users, other
 * entities, later mentions) changes.
 */
export async function resolveRespondedRemindersInTx(
  tx: Prisma.TransactionClient,
  params: { entityType: ReminderEntityType; entityId: string; authorId: string; noteCreatedAt: Date }
): Promise<number> {
  const mentionFilter =
    params.entityType === "project"
      ? { projectNoteMention: { userId: params.authorId, createdAt: { lt: params.noteCreatedAt }, note: { projectId: params.entityId } } }
      : { activityNoteMention: { userId: params.authorId, createdAt: { lt: params.noteCreatedAt }, note: { activityId: params.entityId } } };
  const result = await tx.mentionReminder.updateMany({
    // PROCESSING too: a worker may already hold the claim. Clearing the claim
    // fields makes that worker's token-guarded finalization a no-op.
    where: { status: { in: ["PENDING", "PROCESSING"] }, ...mentionFilter },
    data: { status: "RESPONDED", respondedAt: params.noteCreatedAt, claimedAt: null, claimToken: null },
  });
  return result.count;
}

// ─── User preference ──────────────────────────────────────────────────────────

/** Own-preference update. Disabling cancels every unsent reminder for the user; re-enabling revives nothing. */
export async function setMentionRemindersEnabled(userId: string, enabled: boolean, now: Date = new Date()): Promise<{ cancelled: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { mentionRemindersEnabled: enabled } });
    if (enabled) return { cancelled: 0 };
    const result = await tx.mentionReminder.updateMany({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        OR: [{ projectNoteMention: { userId } }, { activityNoteMention: { userId } }],
      },
      data: { status: "CANCELLED", cancelledAt: now, cancellationReason: "user_opted_out" },
    });
    return { cancelled: result.count };
  });
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export interface ProcessResult {
  claimed: number;
  sent: number;
  responded: number;
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
  // Timestamps are stored as UTC `timestamp` (no tz) columns; passing them as
  // ISO text cast to UTC keeps the comparison independent of the DB session
  // time zone (a bare Date parameter would be interpreted in session tz).
  const nowUtc = now.toISOString();
  const staleBeforeUtc = new Date(now.getTime() - staleAfterMs).toISOString();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "MentionReminder"
    SET status = 'PROCESSING', "claimedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC'), "claimToken" = ${token}, "updatedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC')
    WHERE id IN (
      SELECT id FROM "MentionReminder"
      WHERE (status = 'PENDING' AND "dueAt" <= (${nowUtc}::timestamptz AT TIME ZONE 'UTC'))
         OR (status = 'PROCESSING' AND "claimedAt" < (${staleBeforeUtc}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "dueAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => ({ id: r.id, token }));
}

export type Outcome = "sent" | "responded" | "cancelled" | "lost_claim";

async function finalize(id: string, token: string, data: Prisma.MentionReminderUpdateManyMutationInput, now: Date): Promise<boolean> {
  const r = await prisma.mentionReminder.updateMany({ where: { id, status: "PROCESSING", claimToken: token }, data: { ...data, claimToken: null, updatedAt: now } });
  return r.count === 1;
}

export interface ProcessHooks {
  /** Test seam only: runs after every pre-check, immediately before the final delivery transaction — lets a test commit a competing write at exactly that point. */
  beforeFinalTransaction?: () => Promise<void>;
}

/** Processes ONE already-claimed reminder (the caller holds `token`). Exported so tests can drive the claim/finalize ordering deterministically. */
export async function processClaimedMentionReminder(id: string, token: string, now: Date, hooks: ProcessHooks = {}): Promise<Outcome> {
  return processOne(id, token, now, hooks);
}

async function processOne(id: string, token: string, now: Date, hooks: ProcessHooks = {}): Promise<Outcome> {
  const reminder = await prisma.mentionReminder.findUnique({
    where: { id },
    include: {
      projectNoteMention: { include: { user: true, note: { include: { project: { select: { id: true, title: true, departmentId: true } } } } } },
      activityNoteMention: { include: { user: true, note: { include: { activity: { select: { id: true, title: true, departmentId: true } } } } } },
    },
  });
  if (!reminder || reminder.status !== "PROCESSING" || reminder.claimToken !== token) return "lost_claim";

  const pm = reminder.projectNoteMention;
  const am = reminder.activityNoteMention;
  const entityType: ReminderEntityType = pm ? "project" : "activity";
  const mention = pm ?? am;
  const entity = pm ? pm.note.project : am?.note.activity;
  if (!mention || !entity) {
    return (await finalize(id, token, { status: "CANCELLED", cancelledAt: now, cancellationReason: "source_missing" }, now)) ? "cancelled" : "lost_claim";
  }
  const user = mention.user;

  const cancel = async (reason: string): Promise<Outcome> =>
    (await finalize(id, token, { status: "CANCELLED", cancelledAt: now, cancellationReason: reason }, now)) ? "cancelled" : "lost_claim";

  if (!user.isActive) return cancel("user_inactive");
  if (!user.mentionRemindersEnabled) return cancel("user_opted_out");

  // Defense in depth against a response committed after scheduling.
  const response =
    entityType === "project"
      ? await prisma.projectNote.findFirst({ where: { projectId: entity.id, authorId: user.id, createdAt: { gt: mention.createdAt } }, select: { id: true } })
      : await prisma.activityNote.findFirst({ where: { activityId: entity.id, authorId: user.id, createdAt: { gt: mention.createdAt } }, select: { id: true } });
  if (response) {
    return (await finalize(id, token, { status: "RESPONDED", respondedAt: now }, now)) ? "responded" : "lost_claim";
  }

  if (!(await hasEffectiveEntityPermission(user.id, user.role, user.customRoleId, entity.departmentId, VIEW_KEY[entityType]))) return cancel("lost_view_access");
  if (!(await hasEffectiveEntityPermission(user.id, user.role, user.customRoleId, entity.departmentId, NOTE_KEY[entityType]))) return cancel("lost_note_permission");

  await hooks.beforeFinalTransaction?.();

  // Exactly-once: the SENT transition (token-guarded) and the Notification row
  // commit together. A stale/duplicate worker fails the guard and creates nothing.
  // The guarded update also takes the reminder's row lock, so a concurrent
  // response transaction (which updates the same row) is serialized with it;
  // with the lock held the response is re-checked one last time and, if found,
  // the reminder becomes RESPONDED in this same transaction instead of SENT.
  const finalResult = await prisma.$transaction(async (tx) => {
    const moved = await tx.mentionReminder.updateMany({
      where: { id, status: "PROCESSING", claimToken: token },
      data: { status: "SENT", sentAt: now, claimedAt: null, claimToken: null },
    });
    if (moved.count !== 1) return { kind: "lost" as const };
    const respondedNow =
      entityType === "project"
        ? await tx.projectNote.findFirst({ where: { projectId: entity.id, authorId: user.id, createdAt: { gt: mention.createdAt } }, select: { id: true } })
        : await tx.activityNote.findFirst({ where: { activityId: entity.id, authorId: user.id, createdAt: { gt: mention.createdAt } }, select: { id: true } });
    if (respondedNow) {
      await tx.mentionReminder.update({ where: { id }, data: { status: "RESPONDED", sentAt: null, respondedAt: now } });
      return { kind: "responded" as const };
    }
    const notification = await tx.notification.create({
      data: { userId: user.id, title: REMINDER_TITLE, body: reminderBody(entityType, entity.title), link: reminderLink(entityType, entity.id) },
    });
    return { kind: "sent" as const, notification };
  });
  if (finalResult.kind === "lost") return "lost_claim";
  if (finalResult.kind === "responded") return "responded";
  const created = finalResult.notification;
  await dispatchCreatedNotification(created);
  return "sent";
}

export async function processDueMentionReminders(options: ProcessOptions = {}): Promise<ProcessResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_RUN;
  const staleAfterMs = options.staleAfterMs ?? STALE_CLAIM_TIMEOUT_MS;
  const result: ProcessResult = { claimed: 0, sent: 0, responded: 0, cancelled: 0, failed: 0 };

  for (let i = 0; i < maxBatches; i++) {
    const batch = await claimBatch(now, batchSize, staleAfterMs);
    result.claimed += batch.length;
    for (const { id, token } of batch) {
      try {
        const outcome = await processOne(id, token, now);
        if (outcome === "sent") result.sent++;
        else if (outcome === "responded") result.responded++;
        else if (outcome === "cancelled") result.cancelled++;
      } catch (err) {
        // Left PROCESSING: recoverable after STALE_CLAIM_TIMEOUT_MS. Only the
        // reminder id + error name are logged — never Note text.
        result.failed++;
        console.error(`[mention-reminders] reminder ${id} failed:`, err instanceof Error ? err.name : "unknown");
      }
    }
    if (batch.length < batchSize) break;
  }
  console.info(`[mention-reminders] run at ${now.toISOString()}: claimed=${result.claimed} sent=${result.sent} responded=${result.responded} cancelled=${result.cancelled} failed=${result.failed}`);
  return result;
}
