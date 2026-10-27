/**
 * SQLGeneral Organization Sync — per-user sync-state tracking, enqueue/
 * recovery at Microsoft first (and every later) login, explicit admin
 * refresh, and the claim/process worker. See SqlGeneralUserSyncStatus's own
 * schema doc comment (prisma/schema.prisma) for the full state diagram this
 * file implements.
 *
 * NEVER creates, deletes or modifies a User row — `userId` only identifies
 * whose Department/Company/DepartmentMembership placement this tracks. The
 * actual write (applySqlGeneralDepartmentMembership below) reuses the
 * EXISTING shared OrganizationSyncLock (never a second lock) and performs
 * ownership validation atomically with the write, inside one transaction —
 * never a separate check-then-write step.
 *
 * Real external calls (findSqlGeneralUserByUsername/listAllSqlGeneralDepartments
 * in lib/sqlgeneral-api-client.ts) are implemented, but the WORKER still
 * never runs them unless isSqlGeneralSyncEnabled() is true — see that
 * file's header for exactly what's verified vs. assumed. The read-only
 * Preview surface (previewSqlGeneralUserSync below) is NOT gated on that
 * flag: it exists specifically so an admin can see what sync would do
 * before ever enabling it.
 */
import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { MembershipSource, OrganizationNodeSource, SqlGeneralUserSyncStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { acquireOrganizationSyncLock, releaseOrganizationSyncLock } from "@/lib/services/organization-sync-orchestrator";
import {
  isSqlGeneralSyncEnabled,
  findSqlGeneralUserByUsername,
  listAllSqlGeneralDepartments,
  resolveSqlGeneralDepartmentPlacement,
  type SqlGeneralDepartmentRecord,
  type ResolvedDepartmentPlacement,
} from "@/lib/sqlgeneral-api-client";
import { normalizeCompanyName, normalizeDepartmentName } from "@/lib/services/organization-normalization";
import { resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";

export const MAX_ATTEMPTS = 5;
/** A PROCESSING claim older than this is considered abandoned by a crashed worker and becomes re-claimable — same idiom and default as mention-reminder-service.ts's STALE_CLAIM_TIMEOUT_MS. */
export const STALE_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_BATCH_SIZE = 25;
export const MAX_BATCHES_PER_RUN = 10;

// ─── Enqueue / recovery (called from the Microsoft login hot path) ─────────

/**
 * Called from syncMicrosoftUserDepartment right after the live Graph `/me`
 * call resolves, passing whatever onPremisesSamAccountName it got (or null
 * — a legitimate outcome for a cloud-only account, not a failure). Never
 * throws: any error here is caught and logged, never allowed to fail or
 * even slow down login beyond this best-effort write.
 *
 *   - No row yet: creates one — PENDING if a username is known, otherwise
 *     SKIPPED_NO_USERNAME.
 *   - Existing row, SKIPPED_NO_USERNAME, username now known: revives it to
 *     PENDING — the only "recovery" transition (see SqlGeneralUserSyncStatus).
 *   - Existing row, PENDING, username changed since it was recorded:
 *     refreshes the stored username in place (safe — nothing has claimed it yet).
 *   - Every other case (PROCESSING, SUCCEEDED, FAILED_PERMANENT, or nothing
 *     new to offer): left completely untouched. A terminal row only ever
 *     moves again via an explicit admin refresh
 *     (requestManualSqlGeneralUserSyncRefresh[All] below) — login never
 *     re-triggers one on its own.
 */
export async function enqueueOrRecoverSqlGeneralUserSync(userId: string, sqlGeneralUsername: string | null): Promise<void> {
  try {
    const username = sqlGeneralUsername?.trim() || null;
    const existing = await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId } });

    if (!existing) {
      await prisma.sqlGeneralUserSyncAttempt.create({
        data: { userId, sqlGeneralUsername: username, status: username ? SqlGeneralUserSyncStatus.PENDING : SqlGeneralUserSyncStatus.SKIPPED_NO_USERNAME },
      });
      return;
    }

    if (!username) return; // Nothing new to offer — never downgrades an existing row.

    if (existing.status === SqlGeneralUserSyncStatus.SKIPPED_NO_USERNAME) {
      // Atomic guard (status repeated in the WHERE): if a concurrent login
      // already revived this row, this becomes a harmless no-op.
      await prisma.sqlGeneralUserSyncAttempt.updateMany({
        where: { userId, status: SqlGeneralUserSyncStatus.SKIPPED_NO_USERNAME },
        data: { status: SqlGeneralUserSyncStatus.PENDING, sqlGeneralUsername: username, attemptCount: 0, lastError: null },
      });
      return;
    }

    if (existing.status === SqlGeneralUserSyncStatus.PENDING && existing.sqlGeneralUsername !== username) {
      await prisma.sqlGeneralUserSyncAttempt.updateMany({
        where: { userId, status: SqlGeneralUserSyncStatus.PENDING },
        data: { sqlGeneralUsername: username },
      });
    }
    // PROCESSING / SUCCEEDED / FAILED_PERMANENT: untouched by login.
  } catch (err) {
    console.error("[sqlgeneral-user-sync] enqueue/recover failed, continuing login", { userId, reason: err instanceof Error ? err.name : "unknown" });
  }
}

// ─── Explicit admin refresh ──────────────────────────────────────────────────

export interface ManualRefreshResult {
  userId: string;
  /** false when the row was already PENDING/PROCESSING and was deliberately left untouched. */
  reset: boolean;
}

/**
 * Explicit admin "Sync N" action for one user — the ONLY thing that revives
 * a terminal row (SUCCEEDED / FAILED_PERMANENT / SKIPPED_NO_USERNAME) back
 * to PENDING outside of login's own SKIPPED_NO_USERNAME recovery path.
 * PENDING/PROCESSING is left completely untouched — never resets work
 * already queued or in flight — and `userId` stays `@unique`, so this never
 * creates a second row for a user.
 */
export async function requestManualSqlGeneralUserSyncRefresh(userId: string): Promise<ManualRefreshResult> {
  const existing = await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { userId } });
  if (!existing) {
    await prisma.sqlGeneralUserSyncAttempt.create({ data: { userId, status: SqlGeneralUserSyncStatus.PENDING } });
    return { userId, reset: true };
  }
  if (existing.status === SqlGeneralUserSyncStatus.PENDING || existing.status === SqlGeneralUserSyncStatus.PROCESSING) {
    return { userId, reset: false };
  }
  const result = await prisma.sqlGeneralUserSyncAttempt.updateMany({
    where: {
      userId,
      status: { in: [SqlGeneralUserSyncStatus.SUCCEEDED, SqlGeneralUserSyncStatus.FAILED_PERMANENT, SqlGeneralUserSyncStatus.SKIPPED_NO_USERNAME] },
    },
    data: { status: SqlGeneralUserSyncStatus.PENDING, attemptCount: 0, lastError: null },
  });
  return { userId, reset: result.count === 1 };
}

/**
 * Explicit admin "Sync All" — same per-row semantics as
 * requestManualSqlGeneralUserSyncRefresh, applied to every user that
 * already has an attempt row. Never creates rows for users who have never
 * logged in via Microsoft (nothing to refresh yet); never touches a
 * PENDING/PROCESSING row.
 */
export async function requestManualSqlGeneralUserSyncRefreshAll(): Promise<{ requested: number }> {
  const result = await prisma.sqlGeneralUserSyncAttempt.updateMany({
    where: {
      status: { in: [SqlGeneralUserSyncStatus.SUCCEEDED, SqlGeneralUserSyncStatus.FAILED_PERMANENT, SqlGeneralUserSyncStatus.SKIPPED_NO_USERNAME] },
    },
    data: { status: SqlGeneralUserSyncStatus.PENDING, attemptCount: 0, lastError: null },
  });
  return { requested: result.count };
}

// ─── Atomic write (the only place SQLGeneral touches Department/Company/DepartmentMembership) ─

export type ApplyOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Acquires the EXISTING shared OrganizationSyncLock (never a second lock —
 * see acquireOrganizationSyncLock's own doc comment), re-validates ownership
 * INSIDE the same transaction as the write, and releases the lock
 * immediately after in a `finally`. `placement` was already resolved by an
 * external SQLGeneral call made BEFORE this function runs — the lock is
 * never held during network I/O.
 *
 * Deliberately conservative for this foundation phase: a brand-new Company
 * is safe to create inline (no cascading starter config). A brand-new
 * Department is NOT created here — Department creation has a required
 * starter-config bootstrap (statuses/priorities/SLA, see
 * lib/services/department-service.ts's createDepartment) that doesn't
 * compose safely into this transaction; a Department match that doesn't
 * exist yet is reported as a conflict rather than left half-provisioned.
 * Extending this to create Departments too is future work, gated on the
 * same decision as enabling real external calls in the first place.
 */
async function applySqlGeneralDepartmentMembership(userId: string, placement: ResolvedDepartmentPlacement): Promise<ApplyOutcome> {
  const companyName = placement.department.company;
  const departmentName = placement.department.description;
  if (!companyName) return { ok: false, reason: `Department ${placement.department.id} has no Company value — cannot safely place this user.` };
  if (!departmentName) return { ok: false, reason: `Department ${placement.department.id} has no Description value — cannot safely match/create a local Department without a name.` };

  const lockRunId = `sqlgeneral:${randomUUID()}`;
  const acquired = await acquireOrganizationSyncLock(lockRunId);
  if (!acquired) return { ok: false, reason: "Organization sync lock is held by another sync run." };

  try {
    const normalizedCompanyName = normalizeCompanyName(companyName);
    const normalizedDepartmentName = normalizeDepartmentName(departmentName);

    return await prisma.$transaction(async (tx) => {
      let company = await tx.company.findUnique({ where: { normalizedName: normalizedCompanyName } });
      if (!company) {
        company = await tx.company.create({
          data: {
            name: companyName,
            normalizedName: normalizedCompanyName,
            importSource: OrganizationNodeSource.SQLGENERAL,
            importedAt: new Date(),
            importRunId: lockRunId,
          },
        });
      } else if (company.importSource !== OrganizationNodeSource.SQLGENERAL) {
        // A name collision against a Company this sync does not own (manual,
        // Microsoft-sourced, or no provenance at all) is always a conflict,
        // never claimed — see OrganizationNodeSource's own doc comment.
        return { ok: false, reason: `Company "${companyName}" already exists and is not owned by SQLGeneral sync.` };
      }

      const department = await tx.department.findUnique({
        where: { companyId_normalizedName: { companyId: company.id, normalizedName: normalizedDepartmentName } },
      });
      if (!department) {
        return { ok: false, reason: `No existing Department "${departmentName}" under Company "${companyName}" — SQLGeneral Department auto-creation is not yet implemented.` };
      }
      if (department.importSource !== OrganizationNodeSource.SQLGENERAL) {
        return { ok: false, reason: `Department "${departmentName}" already exists and is not owned by SQLGeneral sync.` };
      }

      const existingMembership = await tx.departmentMembership.findUnique({ where: { userId_departmentId: { userId, departmentId: department.id } } });
      if (existingMembership) {
        if (existingMembership.source !== MembershipSource.SQLGENERAL_DEPARTMENT) {
          return { ok: false, reason: "An existing non-SQLGeneral membership for this user/department is never overwritten." };
        }
        return { ok: true };
      }

      const departmentDefault = await resolveDefaultDepartmentRoleAssignment();
      await tx.departmentMembership.create({
        data: {
          userId,
          departmentId: department.id,
          role: departmentDefault.role,
          customRoleId: departmentDefault.customRoleId,
          source: MembershipSource.SQLGENERAL_DEPARTMENT,
          isPrimary: false,
          isActive: true,
        },
      });
      return { ok: true };
    });
  } finally {
    await releaseOrganizationSyncLock(lockRunId);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function claimBatch(now: Date, batchSize: number, staleAfterMs: number): Promise<{ id: string; token: string }[]> {
  const token = randomUUID();
  const nowUtc = now.toISOString();
  const staleBeforeUtc = new Date(now.getTime() - staleAfterMs).toISOString();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "SqlGeneralUserSyncAttempt"
    SET status = 'PROCESSING', "claimedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC'), "claimToken" = ${token}, "updatedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC')
    WHERE id IN (
      SELECT id FROM "SqlGeneralUserSyncAttempt"
      WHERE status = 'PENDING'
         OR (status = 'PROCESSING' AND "claimedAt" < (${staleBeforeUtc}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => ({ id: r.id, token }));
}

async function finalize(id: string, token: string, data: Prisma.SqlGeneralUserSyncAttemptUpdateManyMutationInput, now: Date): Promise<boolean> {
  const r = await prisma.sqlGeneralUserSyncAttempt.updateMany({ where: { id, status: "PROCESSING", claimToken: token }, data: { ...data, claimToken: null, updatedAt: now } });
  return r.count === 1;
}

export type Outcome = "succeeded" | "skipped_no_username" | "retrying" | "failed_permanent" | "lost_claim";

/** Exported so tests can drive claim/process ordering deterministically — same seam as mention-reminder-service.ts's processClaimedMentionReminder. `departments` is the SAME batch-fetched snapshot every row in one worker run shares (see processDueSqlGeneralUserSyncs) — never re-fetched per row. */
export async function processClaimedSqlGeneralUserSync(id: string, token: string, now: Date, departments: SqlGeneralDepartmentRecord[]): Promise<Outcome> {
  return processOne(id, token, now, departments);
}

async function recordFailureAndMaybeFinalize(id: string, token: string, previousAttemptCount: number, reason: string, now: Date): Promise<Outcome> {
  const attemptCount = previousAttemptCount + 1;
  if (attemptCount >= MAX_ATTEMPTS) {
    return (await finalize(id, token, { status: "FAILED_PERMANENT", attemptCount, lastError: reason.slice(0, 1000) }, now)) ? "failed_permanent" : "lost_claim";
  }
  // Deliberately back to PENDING, not a distinct "FAILED" resting state —
  // see SqlGeneralUserSyncStatus's own doc comment: the claim query above
  // never needs a second branch for a retryable failure.
  return (await finalize(id, token, { status: "PENDING", attemptCount, lastError: reason.slice(0, 1000) }, now)) ? "retrying" : "lost_claim";
}

async function processOne(id: string, token: string, now: Date, departments: SqlGeneralDepartmentRecord[]): Promise<Outcome> {
  const attempt = await prisma.sqlGeneralUserSyncAttempt.findUnique({ where: { id } });
  if (!attempt || attempt.status !== "PROCESSING" || attempt.claimToken !== token) return "lost_claim";

  if (!attempt.sqlGeneralUsername) {
    // Defensive only: reachable if an admin refresh re-armed a row that
    // still has no captured username (e.g. SKIPPED_NO_USERNAME reset by
    // Sync All before any login ever supplied one). No external call, no
    // attempt consumed.
    return (await finalize(id, token, { status: "SKIPPED_NO_USERNAME" }, now)) ? "skipped_no_username" : "lost_claim";
  }

  try {
    const matchResult = await findSqlGeneralUserByUsername(attempt.sqlGeneralUsername);
    if (matchResult.outcome === "not_found") {
      return recordFailureAndMaybeFinalize(id, token, attempt.attemptCount, `No SQLGeneral user found for username "${attempt.sqlGeneralUsername}".`, now);
    }
    if (matchResult.outcome === "ambiguous") {
      return recordFailureAndMaybeFinalize(id, token, attempt.attemptCount, `Username "${attempt.sqlGeneralUsername}" matched ${matchResult.count} SQLGeneral users — requires exactly one match.`, now);
    }

    const { user } = matchResult;
    if (user.hrDepartmentId === null) {
      return recordFailureAndMaybeFinalize(id, token, attempt.attemptCount, `SQLGeneral user "${attempt.sqlGeneralUsername}" has no HrDepartmentId.`, now);
    }

    const placementResult = resolveSqlGeneralDepartmentPlacement(user.hrDepartmentId, departments);
    if (placementResult.outcome === "department_not_found") {
      return recordFailureAndMaybeFinalize(id, token, attempt.attemptCount, `HrDepartmentId "${user.hrDepartmentId}" does not match any fetched SQLGeneral Department.`, now);
    }

    const applied = await applySqlGeneralDepartmentMembership(attempt.userId, placementResult.placement);
    if (!applied.ok) {
      return recordFailureAndMaybeFinalize(id, token, attempt.attemptCount, applied.reason, now);
    }
    return (await finalize(id, token, { status: "SUCCEEDED", attemptCount: attempt.attemptCount + 1, lastError: null }, now)) ? "succeeded" : "lost_claim";
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return recordFailureAndMaybeFinalize(id, token, attempt.attemptCount, reason, now);
  }
}

export interface ProcessResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failedPermanent: number;
  skippedNoUsername: number;
  errored: number;
}

/**
 * Entry point for the worker route/cron. Per REQUIRED #3: when SQLGeneral
 * isn't enabled/verified (see isSqlGeneralSyncEnabled), this returns
 * immediately WITHOUT claiming anything — no row transitions to PROCESSING,
 * no attempt is consumed, nothing can ever reach FAILED_PERMANENT purely
 * because the feature isn't live yet. Equally: if the Departments listing
 * itself can't be fetched this tick (auth/network/pagination failure), this
 * ALSO claims nothing — a shared infrastructure failure must never be
 * split into N separately-consumed per-row attempts.
 */
export async function processDueSqlGeneralUserSyncs(options: { now?: Date; batchSize?: number; maxBatches?: number; staleAfterMs?: number } = {}): Promise<ProcessResult> {
  const result: ProcessResult = { claimed: 0, succeeded: 0, retrying: 0, failedPermanent: 0, skippedNoUsername: 0, errored: 0 };
  if (!isSqlGeneralSyncEnabled()) {
    console.info("[sqlgeneral-user-sync] SQLGENERAL_SYNC_ENABLED is not \"true\" — skipping run, no rows claimed");
    return result;
  }

  const deptResult = await listAllSqlGeneralDepartments();
  if (!deptResult.ok) {
    console.error(`[sqlgeneral-user-sync] could not fetch Departments this run — skipping, no rows claimed: ${deptResult.reason}`);
    return result;
  }
  const departments = deptResult.departments;

  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_RUN;
  const staleAfterMs = options.staleAfterMs ?? STALE_CLAIM_TIMEOUT_MS;

  for (let i = 0; i < maxBatches; i++) {
    const batch = await claimBatch(now, batchSize, staleAfterMs);
    result.claimed += batch.length;
    for (const { id, token } of batch) {
      try {
        const outcome = await processOne(id, token, now, departments);
        if (outcome === "succeeded") result.succeeded++;
        else if (outcome === "retrying") result.retrying++;
        else if (outcome === "failed_permanent") result.failedPermanent++;
        else if (outcome === "skipped_no_username") result.skippedNoUsername++;
      } catch (err) {
        // Left PROCESSING: recoverable after STALE_CLAIM_TIMEOUT_MS.
        result.errored++;
        console.error(`[sqlgeneral-user-sync] attempt ${id} failed:`, err instanceof Error ? err.name : "unknown");
      }
    }
    if (batch.length < batchSize) break;
  }
  console.info(
    `[sqlgeneral-user-sync] run at ${now.toISOString()}: claimed=${result.claimed} succeeded=${result.succeeded} retrying=${result.retrying} failedPermanent=${result.failedPermanent} skippedNoUsername=${result.skippedNoUsername} errored=${result.errored}`
  );
  return result;
}

// ─── Read-only Preview (never writes; never gated on isSqlGeneralSyncEnabled) ─

export interface SqlGeneralPreviewRow {
  userId: string;
  sqlGeneralUsername: string | null;
  usernameMatch: "unique" | "not_found" | "ambiguous" | "no_username_captured";
  hrDepartmentId: string | number | null;
  departmentResolution: "resolved" | "department_not_found" | "n/a";
  departmentDescription: string | null;
  company: string | null;
  companyShortname: string | null;
  /** Root-to-immediate-parent department descriptions (or raw id if a link has no description) — built purely from ParentDepartmentId, never from names or manager chains. */
  parentChain: string[];
  missingParent: boolean;
  localMatch: "none" | "existing_sqlgeneral_owned" | "conflict_other_owner";
  conflictDetail: string | null;
}

function emptyPreviewRow(userId: string, sqlGeneralUsername: string | null, usernameMatch: SqlGeneralPreviewRow["usernameMatch"]): SqlGeneralPreviewRow {
  return {
    userId,
    sqlGeneralUsername,
    usernameMatch,
    hrDepartmentId: null,
    departmentResolution: "n/a",
    departmentDescription: null,
    company: null,
    companyShortname: null,
    parentChain: [],
    missingParent: false,
    localMatch: "none",
    conflictDetail: null,
  };
}

/**
 * Read-only "what would SQLGeneral sync do" report for N explicit users or
 * EVERY eligible TicketApp user — REQUIRED #6. "Eligible" (the `all` case
 * only — an explicit `userIds` list is always previewed as given, no
 * filtering, since the admin chose those specific users) means `isActive`
 * AND `microsoftUserId` is set: only a Microsoft-authenticated user can
 * ever have a real, Graph-verified onPremisesSamAccountName at all, so a
 * credentials-only local account is never a meaningful SQLGeneral match
 * candidate. Every eligible/requested user gets exactly one output row,
 * whether or not they already have a SqlGeneralUserSyncAttempt — a user
 * with no attempt row yet (never logged in since this feature shipped, and
 * never admin-refreshed) is reported as "no_username_captured", the exact
 * same bucket as an attempt row whose username happens to be null — never
 * silently omitted. This never creates, modifies or infers a User field,
 * and never changes how a username is matched (still exclusively the
 * already-captured, Graph-verified value) — it only changes which users
 * are INCLUDED in the report. Never writes anything (no lock acquired, no
 * transaction, applySqlGeneralDepartmentMembership is never called).
 * Fetches the Departments listing exactly once and reuses it for every
 * target user, same as the worker.
 */
export async function previewSqlGeneralUserSync(target: { userIds: string[] } | { all: true }): Promise<{ ok: true; rows: SqlGeneralPreviewRow[] } | { ok: false; reason: string }> {
  const deptResult = await listAllSqlGeneralDepartments();
  if (!deptResult.ok) return { ok: false, reason: deptResult.reason };
  const departments = deptResult.departments;

  const targetUserIds =
    "all" in target
      ? (await prisma.user.findMany({ where: { isActive: true, microsoftUserId: { not: null } }, select: { id: true } })).map((u) => u.id)
      : target.userIds;

  const attempts = await prisma.sqlGeneralUserSyncAttempt.findMany({ where: { userId: { in: targetUserIds } } });
  const attemptByUserId = new Map(attempts.map((a) => [a.userId, a]));

  const rows: SqlGeneralPreviewRow[] = [];
  for (const userId of targetUserIds) {
    const attemptRow = attemptByUserId.get(userId);
    if (!attemptRow?.sqlGeneralUsername) {
      rows.push(emptyPreviewRow(userId, attemptRow?.sqlGeneralUsername ?? null, "no_username_captured"));
      continue;
    }
    const sqlGeneralUsername = attemptRow.sqlGeneralUsername;

    let matchResult: Awaited<ReturnType<typeof findSqlGeneralUserByUsername>>;
    try {
      matchResult = await findSqlGeneralUserByUsername(sqlGeneralUsername);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (matchResult.outcome !== "unique") {
      rows.push(emptyPreviewRow(userId, sqlGeneralUsername, matchResult.outcome));
      continue;
    }

    const { user } = matchResult;
    if (user.hrDepartmentId === null) {
      rows.push({ ...emptyPreviewRow(userId, sqlGeneralUsername, "unique"), company: user.company });
      continue;
    }

    const placementResult = resolveSqlGeneralDepartmentPlacement(user.hrDepartmentId, departments);
    if (placementResult.outcome === "department_not_found") {
      rows.push({ ...emptyPreviewRow(userId, sqlGeneralUsername, "unique"), hrDepartmentId: user.hrDepartmentId, departmentResolution: "department_not_found", company: user.company });
      continue;
    }

    const { department, parentChain, missingParent } = placementResult.placement;
    const companyName = department.company ?? user.company;
    const departmentName = department.description;

    let localMatch: SqlGeneralPreviewRow["localMatch"] = "none";
    let conflictDetail: string | null = null;
    if (companyName) {
      const existingCompany = await prisma.company.findUnique({ where: { normalizedName: normalizeCompanyName(companyName) } });
      if (existingCompany) {
        if (existingCompany.importSource !== OrganizationNodeSource.SQLGENERAL) {
          localMatch = "conflict_other_owner";
          conflictDetail = `Company "${companyName}" already exists and is not owned by SQLGeneral sync.`;
        } else {
          localMatch = "existing_sqlgeneral_owned";
          if (departmentName) {
            const existingDept = await prisma.department.findUnique({
              where: { companyId_normalizedName: { companyId: existingCompany.id, normalizedName: normalizeDepartmentName(departmentName) } },
            });
            if (existingDept && existingDept.importSource !== OrganizationNodeSource.SQLGENERAL) {
              localMatch = "conflict_other_owner";
              conflictDetail = `Department "${departmentName}" already exists under Company "${companyName}" and is not owned by SQLGeneral sync.`;
            } else if (!existingDept) {
              conflictDetail = `No existing Department "${departmentName}" under Company "${companyName}" — would require SQLGeneral Department auto-creation, not yet implemented.`;
            }
          }
        }
      }
    }

    rows.push({
      userId,
      sqlGeneralUsername,
      usernameMatch: "unique",
      hrDepartmentId: user.hrDepartmentId,
      departmentResolution: "resolved",
      departmentDescription: departmentName,
      company: companyName,
      companyShortname: department.companyShortname,
      parentChain: parentChain.map((p) => p.description ?? String(p.id)),
      missingParent,
      localMatch,
      conflictDetail,
    });
  }
  return { ok: true, rows };
}
