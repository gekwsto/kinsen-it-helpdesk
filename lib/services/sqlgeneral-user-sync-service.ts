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
  verifySqlGeneralCompanyIdExists,
  verifySqlGeneralDepartmentIdExists,
  type SqlGeneralDepartmentRecord,
  type ResolvedDepartmentPlacement,
} from "@/lib/sqlgeneral-api-client";
import { normalizeCompanyName, normalizeDepartmentName } from "@/lib/services/organization-normalization";
import { resolveDefaultDepartmentRoleAssignment } from "@/lib/services/default-role-service";
import { fetchAllGraphUserIdentities, type GraphUserIdentity } from "@/lib/services/microsoft-directory-service";

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
 *
 * `sqlGeneralCompanyId` (the stable id from the matched SQLGeneral user row
 * — see SqlGeneralCompanyMapping's own schema doc comment) is checked for
 * an admin-approved mapping FIRST, INSIDE this same transaction (re-
 * validated at write time, never trusting a stale read) — when one exists,
 * it is used directly instead of any name-based company resolution, and
 * the mapped Company's own fields/ownership are never written to. With no
 * approved mapping, behavior is completely unchanged from before this
 * feature: name-based find-or-create, conflict on any non-SQLGeneral owner.
 */
async function applySqlGeneralDepartmentMembership(userId: string, placement: ResolvedDepartmentPlacement, sqlGeneralCompanyId: string | null): Promise<ApplyOutcome> {
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
      const approvedMapping = sqlGeneralCompanyId
        ? await tx.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId }, select: { company: true } })
        : null;

      let company = approvedMapping?.company ?? null;
      if (!company) {
        company = await tx.company.findUnique({ where: { normalizedName: normalizedCompanyName } });
      }
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
      } else if (!approvedMapping && company.importSource !== OrganizationNodeSource.SQLGENERAL) {
        // A name collision against a Company this sync does not own (manual,
        // Microsoft-sourced, or no provenance at all) is always a conflict,
        // never claimed — see OrganizationNodeSource's own doc comment.
        // An approved mapping is the one explicit, admin-reviewed exception —
        // it bypasses this check entirely, but never touches the Company's
        // own ownership/fields either way.
        return { ok: false, reason: `Company "${companyName}" already exists and is not owned by SQLGeneral sync.` };
      }

      const sqlGeneralDepartmentId = String(placement.department.id);
      const approvedDeptMapping = await tx.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId }, select: { department: true } });

      let department = null as Awaited<ReturnType<typeof tx.department.findUnique>>;
      if (approvedDeptMapping) {
        // Re-validate the SAME hierarchy integrity at write time (REQUIRED
        // #5, this round) — an approved mapping is never trusted blindly;
        // the chain must still resolve as root/verified RIGHT NOW, inside
        // this same transaction, never a separate, earlier check-then-write
        // gap.
        if (!approvedDeptMapping.department.companyId) {
          return { ok: false, reason: `Approved Department mapping's target no longer has a Company — refusing to write.` };
        }
        const hierarchyValidation = await validateDepartmentHierarchy(
          placement.parentChain,
          placement.missingParent,
          approvedDeptMapping.department.companyId,
          (id) => tx.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId: id }, select: { department: { select: { companyId: true } } } }).then((m) => (m ? { companyId: m.department.companyId } : null))
        );
        const hierarchyFailure = describeHierarchyValidationFailure(hierarchyValidation);
        if (hierarchyFailure) return { ok: false, reason: `Approved Department mapping failed re-validation at write time: ${hierarchyFailure}` };
        department = approvedDeptMapping.department;
      }
      if (!department) {
        department = await tx.department.findUnique({
          where: { companyId_normalizedName: { companyId: company.id, normalizedName: normalizedDepartmentName } },
        });
      }
      if (!department) {
        return { ok: false, reason: `No existing Department "${departmentName}" under Company "${companyName}" — SQLGeneral Department auto-creation is not yet implemented.` };
      }
      if (!approvedDeptMapping && department.importSource !== OrganizationNodeSource.SQLGENERAL) {
        // Same explicit-mapping exception as the Company check above — an
        // approved Department mapping bypasses this, but never touches the
        // Department's own ownership/fields/hierarchy either way.
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

    const sqlGeneralCompanyId = user.companyId !== null ? String(user.companyId) : null;
    const applied = await applySqlGeneralDepartmentMembership(attempt.userId, placementResult.placement, sqlGeneralCompanyId);
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
  /** The SQLGeneral user row's own stable CompanyId (String — see SqlGeneralCompanyMapping's schema doc comment), the key an admin would use to approve a mapping. Null whenever usernameMatch isn't "unique" or the matched user has no CompanyId. */
  sqlGeneralCompanyId: string | null;
  hrDepartmentId: string | number | null;
  departmentResolution: "resolved" | "department_not_found" | "n/a";
  departmentDescription: string | null;
  company: string | null;
  companyShortname: string | null;
  /** Root-to-immediate-parent department descriptions (or raw id if a link has no description) — built purely from ParentDepartmentId, never from names or manager chains. */
  parentChain: string[];
  missingParent: boolean;
  /** "approved_external_mapping": resolved via an admin-approved SqlGeneralCompanyMapping — the target Company is NOT SQLGeneral-owned and never will be by this alone; distinct from "existing_sqlgeneral_owned" (which really is owned by this sync) so the two are never conflated. */
  localMatch: "none" | "existing_sqlgeneral_owned" | "conflict_other_owner" | "approved_external_mapping";
  conflictDetail: string | null;
  /** Which node level the conflict is actually at — null whenever localMatch isn't conflict_other_owner. Distinct from conflictDetail's free text so a caller can branch on it structurally. */
  conflictLevel: "company" | "department" | null;
}

function emptyPreviewRow(userId: string, sqlGeneralUsername: string | null, usernameMatch: SqlGeneralPreviewRow["usernameMatch"]): SqlGeneralPreviewRow {
  return {
    userId,
    sqlGeneralUsername,
    usernameMatch,
    sqlGeneralCompanyId: null,
    hrDepartmentId: null,
    departmentResolution: "n/a",
    departmentDescription: null,
    company: null,
    companyShortname: null,
    parentChain: [],
    missingParent: false,
    localMatch: "none",
    conflictDetail: null,
    conflictLevel: null,
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
    const sqlGeneralCompanyId = user.companyId !== null ? String(user.companyId) : null;
    if (user.hrDepartmentId === null) {
      rows.push({ ...emptyPreviewRow(userId, sqlGeneralUsername, "unique"), sqlGeneralCompanyId, company: user.company });
      continue;
    }

    const placementResult = resolveSqlGeneralDepartmentPlacement(user.hrDepartmentId, departments);
    if (placementResult.outcome === "department_not_found") {
      rows.push({ ...emptyPreviewRow(userId, sqlGeneralUsername, "unique"), sqlGeneralCompanyId, hrDepartmentId: user.hrDepartmentId, departmentResolution: "department_not_found", company: user.company });
      continue;
    }

    const { department, parentChain, missingParent } = placementResult.placement;
    const companyName = department.company ?? user.company;
    const departmentName = department.description;
    const sqlGeneralDepartmentId = String(department.id);

    let localMatch: SqlGeneralPreviewRow["localMatch"] = "none";
    let conflictDetail: string | null = null;
    let conflictLevel: SqlGeneralPreviewRow["conflictLevel"] = null;
    let resolvedCompany: { id: string; name: string } | null = null;

    const approvedCompanyMapping = sqlGeneralCompanyId ? await prisma.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId }, select: { company: true } }) : null;
    if (approvedCompanyMapping) {
      // An admin has explicitly reviewed and approved this exact SQLGeneral
      // CompanyId against this exact local Company — bypass the name-based
      // check entirely, but this is NOT the same as SQLGeneral owning it
      // (see localMatch's own doc comment).
      resolvedCompany = approvedCompanyMapping.company;
      localMatch = "approved_external_mapping";
    } else if (companyName) {
      const existingCompany = await prisma.company.findUnique({ where: { normalizedName: normalizeCompanyName(companyName) } });
      if (existingCompany) {
        if (existingCompany.importSource !== OrganizationNodeSource.SQLGENERAL) {
          localMatch = "conflict_other_owner";
          conflictLevel = "company";
          conflictDetail = `Company "${companyName}" already exists and is not owned by SQLGeneral sync.`;
          // Blocked at the Company level — the Department-level check below
          // never runs; resolvedCompany stays null on purpose.
        } else {
          resolvedCompany = existingCompany;
          localMatch = "existing_sqlgeneral_owned";
        }
      }
      // No existingCompany at all: resolvedCompany stays null, localMatch
      // stays "none" — a brand-new Company (and therefore Department) would
      // be created fresh; the Department-level check below doesn't apply.
    }

    // One shared Department-level check, reached whenever a Company was
    // actually resolved above (approved-mapped, or SQLGeneral-owned) —
    // consolidated from what used to be two near-identical copies so the
    // NEW SqlGeneralDepartmentMapping check only has to be written once and
    // applies identically to both paths (REQUIRED #6: "sync and preview
    // both resolve approved mappings consistently").
    if (resolvedCompany && departmentName) {
      const approvedDeptMapping = await prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId }, select: { department: true } });
      if (approvedDeptMapping) {
        // An admin has explicitly approved THIS exact Department bridge —
        // authoritative regardless of the existing Department's own
        // ownership, which is never touched by this.
        localMatch = "approved_external_mapping";
      } else {
        const existingDept = await prisma.department.findUnique({
          where: { companyId_normalizedName: { companyId: resolvedCompany.id, normalizedName: normalizeDepartmentName(departmentName) } },
        });
        if (existingDept && existingDept.importSource !== OrganizationNodeSource.SQLGENERAL) {
          localMatch = "conflict_other_owner";
          conflictLevel = "department";
          conflictDetail = `Department "${departmentName}" already exists under Company "${resolvedCompany.name}" and is not owned by SQLGeneral sync.`;
        } else if (!existingDept) {
          conflictDetail = `No existing Department "${departmentName}" under Company "${resolvedCompany.name}" — would require SQLGeneral Department auto-creation, not yet implemented.`;
        }
      }
    }

    rows.push({
      userId,
      sqlGeneralUsername,
      usernameMatch: "unique",
      sqlGeneralCompanyId,
      hrDepartmentId: user.hrDepartmentId,
      departmentResolution: "resolved",
      departmentDescription: departmentName,
      company: resolvedCompany ? resolvedCompany.name : companyName,
      companyShortname: department.companyShortname,
      parentChain: parentChain.map((p) => p.description ?? String(p.id)),
      missingParent,
      localMatch,
      conflictDetail,
      conflictLevel,
    });
  }
  return { ok: true, rows };
}

// ─── Explicit admin-approved Company mapping ───────────────────────────────

export interface CompanyMappingCandidate {
  sqlGeneralCompanyId: string;
  /** The existing mapping for this sqlGeneralCompanyId, if any — present whether or not it matches `targetCompanyId`, so a caller can tell "already mapped to X" apart from "would create a NEW mapping to Y". */
  existingMapping: { companyId: string; companyName: string; approvedById: string; approvedAt: Date } | null;
  /** The company this approval would point at — null if targetCompanyId doesn't exist, which the caller must treat as a hard error, never a stub creation. */
  targetCompany: { id: string; name: string; importSource: OrganizationNodeSource | null } | null;
  /**
   * OTHER already-approved SQLGeneral CompanyIds (never including this
   * one) already pointing at targetCompanyId. A legitimate, allowed
   * state (many-to-one is explicitly preserved, never blocked outright)
   * — but approveSqlGeneralCompanyMapping requires `confirmMultipleMapping:
   * true` before adding to it, so an admin never creates one by accident.
   */
  otherMappingsToSameTarget: string[];
  /** Whether SQLGeneral itself confirms sqlGeneralCompanyId is a real, currently-used CompanyId — null if verification could not be performed at all (e.g. not configured), which the caller must treat as "cannot confirm", never as a pass. */
  sourceVerified: boolean | null;
  sourceVerificationError: string | null;
}

/**
 * Read-only. Lets an admin see exactly what approving `{ sqlGeneralCompanyId,
 * targetCompanyId }` would do BEFORE calling approveSqlGeneralCompanyMapping
 * — whether a mapping already exists, whether targetCompanyId is a real
 * Company, whether this would create a many-to-one mapping, and whether
 * the source id itself is even real. Never writes anything.
 */
export async function previewSqlGeneralCompanyMappingCandidate(sqlGeneralCompanyId: string, targetCompanyId: string): Promise<CompanyMappingCandidate> {
  const [existing, targetCompany, otherMappings, sourceCheck] = await Promise.all([
    prisma.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId }, select: { companyId: true, approvedById: true, approvedAt: true, company: { select: { name: true } } } }),
    prisma.company.findUnique({ where: { id: targetCompanyId }, select: { id: true, name: true, importSource: true } }),
    prisma.sqlGeneralCompanyMapping.findMany({ where: { companyId: targetCompanyId, sqlGeneralCompanyId: { not: sqlGeneralCompanyId } }, select: { sqlGeneralCompanyId: true } }),
    verifySqlGeneralCompanyIdExists(sqlGeneralCompanyId),
  ]);
  return {
    sqlGeneralCompanyId,
    existingMapping: existing ? { companyId: existing.companyId, companyName: existing.company.name, approvedById: existing.approvedById, approvedAt: existing.approvedAt } : null,
    targetCompany: targetCompany ?? null,
    otherMappingsToSameTarget: otherMappings.map((m) => m.sqlGeneralCompanyId),
    sourceVerified: sourceCheck.ok ? sourceCheck.exists : null,
    sourceVerificationError: sourceCheck.ok ? null : sourceCheck.reason,
  };
}

export type ApproveCompanyMappingResult =
  | { ok: true; mapping: { sqlGeneralCompanyId: string; companyId: string; approvedById: string; approvedAt: Date } }
  | { ok: false; reason: string };

/**
 * The ONLY way a SqlGeneralCompanyMapping row is ever created — always an
 * explicit admin action naming both ids, NEVER inferred from a name match.
 * Revalidates everything at approval time, never trusting an earlier
 * preview call:
 *   1. sqlGeneralCompanyId must be independently confirmed to exist in
 *      SQLGeneral's own live data (verifySqlGeneralCompanyIdExists) — a
 *      verification FAILURE (not configured/network/etc.) is treated the
 *      SAME as "does not exist": rejected, never approved on an unverifiable
 *      identifier.
 *   2. targetCompanyId must be a real, existing Company — never a stub
 *      creation.
 *   3. Re-pointing an EXISTING mapping for this sqlGeneralCompanyId at a
 *      DIFFERENT company is rejected outright (duplicate-prevention);
 *      re-approving the SAME pair is a safe, idempotent no-op.
 *   4. Adding a genuinely NEW sqlGeneralCompanyId -> targetCompanyId
 *      mapping when targetCompanyId ALREADY has one or more mappings from
 *      OTHER sqlGeneralCompanyIds requires `confirmMultipleMapping: true`
 *      — many-to-one is a legitimate, preserved state, never silently
 *      created.
 * Never writes to the target Company's own fields
 * (name/normalizedName/importSource/domain) or to any User row.
 */
export async function approveSqlGeneralCompanyMapping(
  sqlGeneralCompanyId: string,
  targetCompanyId: string,
  approvedById: string,
  confirmMultipleMapping = false
): Promise<ApproveCompanyMappingResult> {
  const sourceCheck = await verifySqlGeneralCompanyIdExists(sqlGeneralCompanyId);
  if (!sourceCheck.ok) return { ok: false, reason: `Could not verify SQLGeneral CompanyId "${sqlGeneralCompanyId}" against live SQLGeneral data (${sourceCheck.reason}) — never approving an unverifiable identifier.` };
  if (!sourceCheck.exists) return { ok: false, reason: `SQLGeneral CompanyId "${sqlGeneralCompanyId}" was not found in current SQLGeneral data — refusing to approve an arbitrary/unknown identifier.` };

  const targetCompany = await prisma.company.findUnique({ where: { id: targetCompanyId }, select: { id: true } });
  if (!targetCompany) return { ok: false, reason: `No Company exists with id "${targetCompanyId}".` };

  const existing = await prisma.sqlGeneralCompanyMapping.findUnique({ where: { sqlGeneralCompanyId } });
  if (existing && existing.companyId !== targetCompanyId) {
    return { ok: false, reason: `SQLGeneral CompanyId "${sqlGeneralCompanyId}" is already mapped to a different Company (id="${existing.companyId}") — remove that mapping first if it should change.` };
  }
  if (existing) {
    // Idempotent re-approval of the exact same pair — safe no-op, not an error.
    return { ok: true, mapping: { sqlGeneralCompanyId, companyId: existing.companyId, approvedById: existing.approvedById, approvedAt: existing.approvedAt } };
  }

  if (!confirmMultipleMapping) {
    const otherMappingCount = await prisma.sqlGeneralCompanyMapping.count({ where: { companyId: targetCompanyId } });
    if (otherMappingCount > 0) {
      return { ok: false, reason: `Company "${targetCompanyId}" already has ${otherMappingCount} other approved SQLGeneral mapping(s) — this would create a many-to-one mapping. Pass confirmMultipleMapping: true to proceed; this is allowed, but never created without explicit confirmation.` };
    }
  }

  const created = await prisma.sqlGeneralCompanyMapping.create({
    data: { sqlGeneralCompanyId, companyId: targetCompanyId, approvedById },
  });
  return { ok: true, mapping: { sqlGeneralCompanyId: created.sqlGeneralCompanyId, companyId: created.companyId, approvedById: created.approvedById, approvedAt: created.approvedAt } };
}

// ─── Explicit admin-approved Department mapping ────────────────────────────

export interface DepartmentMappingCandidate {
  sqlGeneralDepartmentId: string;
  existingMapping: { departmentId: string; departmentName: string; approvedById: string; approvedAt: Date } | null;
  targetDepartment: { id: string; name: string; companyId: string | null; importSource: OrganizationNodeSource | null } | null;
  /** Other already-approved SQLGeneral DepartmentIds (never including this one) already pointing at this same target — same many-to-one semantics as CompanyMappingCandidate. */
  otherMappingsToSameTarget: string[];
  sourceVerified: boolean | null;
  sourceVerificationError: string | null;
  /**
   * The approved SqlGeneralCompanyMapping for the target Department's OWN
   * companyId, if any — null if the target has no companyId, or that
   * Company has no approved mapping yet, which approveSqlGeneralDepartmentMapping
   * treats as an unsafe parent relationship and refuses (REQUIRED #6): a
   * Department mapping is only ever layered on top of an already-approved
   * Company mapping, never standing alone.
   */
  companyMappingForTargetDepartment: { sqlGeneralCompanyId: string } | null;
  /** Whether the SOURCE department's SQLGeneral parent chain is actually compatible with the TARGET's local placement — see validateDepartmentHierarchy's own doc comment for the exact rules. Never inferred from missingParent alone. */
  hierarchyValidation: DepartmentHierarchyValidation;
}

export type DepartmentHierarchyValidation =
  | { status: "root" }
  | { status: "verified" }
  | { status: "unresolved"; reason: string }
  | { status: "unmapped_ancestor"; sqlGeneralDepartmentId: string }
  | { status: "conflicting_ancestor"; sqlGeneralDepartmentId: string; mappedCompanyId: string | null };

/**
 * TicketApp's Department has NO self-referential parent — it nests under
 * BusinessUnit or directly under Company, never under another Department,
 * unlike SQLGeneral's Department -> Department chains (which can be
 * several levels deep — see this session's own earlier hierarchy
 * findings). So "parent-chain compatibility" can never be a literal
 * node-by-node structural match; the only honest, verifiable notion of it
 * is: every ancestor in the SOURCE chain, up to the root, must ALREADY
 * have its own approved SqlGeneralDepartmentMapping, and every one of
 * those already-mapped ancestors must point at a local Department in the
 * SAME Company as the target being approved now. This enforces a strict
 * top-down approval order (map the root first, then its children, etc.)
 * and catches real conflicts (an ancestor already mapped into a DIFFERENT
 * Company than the one being proposed for its child).
 *
 * Deliberately does NOT treat `missingParent: false` as sufficient on its
 * own — that only proves the SOURCE chain resolves within SQLGeneral's own
 * data; it says nothing about whether the LOCAL mapping chain is
 * consistent, which is the actual thing being verified here. A genuine
 * root (no ParentDepartmentId at all) has nothing to verify and is always
 * "root" — compatible by construction, not by inference.
 *
 * `lookupApprovedMapping` is injected so this same pure chain-walking logic
 * can run against either the live `prisma` client (Preview/approve) or a
 * `tx` inside the write-path transaction (REQUIRED #5 — same validation at
 * write time, so an approval can never be bypassed by a later change).
 */
async function validateDepartmentHierarchy(
  parentChain: SqlGeneralDepartmentRecord[],
  missingParent: boolean,
  targetCompanyId: string,
  lookupApprovedMapping: (sqlGeneralDepartmentId: string) => Promise<{ companyId: string | null } | null>
): Promise<DepartmentHierarchyValidation> {
  if (missingParent) {
    return { status: "unresolved", reason: "A ParentDepartmentId in this department's chain does not resolve within the fetched SQLGeneral Departments set — ambiguous, cannot be verified." };
  }
  if (parentChain.length === 0) return { status: "root" };

  for (const ancestor of parentChain) {
    const ancestorSqlGeneralId = String(ancestor.id);
    const mapped = await lookupApprovedMapping(ancestorSqlGeneralId);
    if (!mapped) return { status: "unmapped_ancestor", sqlGeneralDepartmentId: ancestorSqlGeneralId };
    if (mapped.companyId !== targetCompanyId) {
      return { status: "conflicting_ancestor", sqlGeneralDepartmentId: ancestorSqlGeneralId, mappedCompanyId: mapped.companyId };
    }
  }
  return { status: "verified" };
}

function describeHierarchyValidationFailure(v: DepartmentHierarchyValidation): string | null {
  if (v.status === "root" || v.status === "verified") return null;
  if (v.status === "unresolved") return v.reason;
  if (v.status === "unmapped_ancestor") return `Ancestor SQLGeneral Departments.Id "${v.sqlGeneralDepartmentId}" has no approved SqlGeneralDepartmentMapping yet — map ancestors top-down before their children.`;
  return `Ancestor SQLGeneral Departments.Id "${v.sqlGeneralDepartmentId}" is already mapped into a different Company than the one being proposed here.`;
}

/**
 * Read-only. Mirrors previewSqlGeneralCompanyMappingCandidate exactly, plus
 * the Department-specific "does the target's own Company already have an
 * approved mapping" check and the parent-hierarchy validation above. Never
 * writes anything.
 */
export async function previewSqlGeneralDepartmentMappingCandidate(sqlGeneralDepartmentId: string, targetDepartmentId: string): Promise<DepartmentMappingCandidate> {
  const [existing, targetDepartment, otherMappings, sourceCheck, deptResult] = await Promise.all([
    prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId }, select: { departmentId: true, approvedById: true, approvedAt: true, department: { select: { name: true } } } }),
    prisma.department.findUnique({ where: { id: targetDepartmentId }, select: { id: true, name: true, companyId: true, importSource: true } }),
    prisma.sqlGeneralDepartmentMapping.findMany({ where: { departmentId: targetDepartmentId, sqlGeneralDepartmentId: { not: sqlGeneralDepartmentId } }, select: { sqlGeneralDepartmentId: true } }),
    verifySqlGeneralDepartmentIdExists(sqlGeneralDepartmentId),
    listAllSqlGeneralDepartments(),
  ]);

  const companyMapping = targetDepartment?.companyId
    ? await prisma.sqlGeneralCompanyMapping.findFirst({ where: { companyId: targetDepartment.companyId }, select: { sqlGeneralCompanyId: true } })
    : null;

  let hierarchyValidation: DepartmentHierarchyValidation = { status: "unresolved", reason: "Could not be checked (see sourceVerificationError / targetDepartment)." };
  if (targetDepartment?.companyId) {
    if (!deptResult.ok) {
      hierarchyValidation = { status: "unresolved", reason: deptResult.reason };
    } else {
      const placementResult = resolveSqlGeneralDepartmentPlacement(sqlGeneralDepartmentId, deptResult.departments);
      hierarchyValidation =
        placementResult.outcome === "department_not_found"
          ? { status: "unresolved", reason: `SQLGeneral Departments.Id "${sqlGeneralDepartmentId}" was not found in the fetched Departments set.` }
          : await validateDepartmentHierarchy(placementResult.placement.parentChain, placementResult.placement.missingParent, targetDepartment.companyId, (id) =>
              prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId: id }, select: { department: { select: { companyId: true } } } }).then((m) => (m ? { companyId: m.department.companyId } : null))
            );
    }
  }

  return {
    sqlGeneralDepartmentId,
    existingMapping: existing ? { departmentId: existing.departmentId, departmentName: existing.department.name, approvedById: existing.approvedById, approvedAt: existing.approvedAt } : null,
    targetDepartment: targetDepartment ?? null,
    otherMappingsToSameTarget: otherMappings.map((m) => m.sqlGeneralDepartmentId),
    sourceVerified: sourceCheck.ok ? sourceCheck.exists : null,
    sourceVerificationError: sourceCheck.ok ? null : sourceCheck.reason,
    companyMappingForTargetDepartment: companyMapping,
    hierarchyValidation,
  };
}

export type ApproveDepartmentMappingResult =
  | { ok: true; mapping: { sqlGeneralDepartmentId: string; departmentId: string; approvedById: string; approvedAt: Date } }
  | { ok: false; reason: string };

/**
 * The ONLY way a SqlGeneralDepartmentMapping row is ever created — mirrors
 * approveSqlGeneralCompanyMapping's revalidation order exactly, plus two
 * Department-specific preconditions: the target Department's own Company
 * must ALREADY have an approved SqlGeneralCompanyMapping (REQUIRED #6 from
 * the prior round), and the SOURCE department's own parent chain must
 * validate as "root" or "verified" per validateDepartmentHierarchy above —
 * "unresolved"/"unmapped_ancestor"/"conflicting_ancestor" are all refused.
 * Never writes to the target Department's own fields (name/normalizedName/
 * importSource/businessUnitId/companyId) or reparents it, and never
 * touches any User row.
 */
export async function approveSqlGeneralDepartmentMapping(
  sqlGeneralDepartmentId: string,
  targetDepartmentId: string,
  approvedById: string,
  confirmMultipleMapping = false
): Promise<ApproveDepartmentMappingResult> {
  const sourceCheck = await verifySqlGeneralDepartmentIdExists(sqlGeneralDepartmentId);
  if (!sourceCheck.ok) return { ok: false, reason: `Could not verify SQLGeneral Departments.Id "${sqlGeneralDepartmentId}" against live SQLGeneral data (${sourceCheck.reason}) — never approving an unverifiable identifier.` };
  if (!sourceCheck.exists) return { ok: false, reason: `SQLGeneral Departments.Id "${sqlGeneralDepartmentId}" was not found in current SQLGeneral data — refusing to approve an arbitrary/unknown identifier.` };

  const targetDepartment = await prisma.department.findUnique({ where: { id: targetDepartmentId }, select: { id: true, companyId: true } });
  if (!targetDepartment) return { ok: false, reason: `No Department exists with id "${targetDepartmentId}".` };

  if (!targetDepartment.companyId) {
    return { ok: false, reason: `Department "${targetDepartmentId}" has no Company at all — an unsafe parent relationship; approve a Company mapping for its intended Company first.` };
  }
  const companyMapping = await prisma.sqlGeneralCompanyMapping.findFirst({ where: { companyId: targetDepartment.companyId }, select: { sqlGeneralCompanyId: true } });
  if (!companyMapping) {
    return { ok: false, reason: `Department "${targetDepartmentId}"'s Company ("${targetDepartment.companyId}") has no approved SqlGeneralCompanyMapping yet — an unsafe parent relationship; a Department mapping can only be approved on top of an already-approved Company mapping.` };
  }

  const deptResult = await listAllSqlGeneralDepartments();
  if (!deptResult.ok) return { ok: false, reason: `Could not fetch SQLGeneral Departments to verify parent-hierarchy compatibility (${deptResult.reason}) — never approving an unverifiable hierarchy.` };
  const placementResult = resolveSqlGeneralDepartmentPlacement(sqlGeneralDepartmentId, deptResult.departments);
  if (placementResult.outcome === "department_not_found") {
    return { ok: false, reason: `SQLGeneral Departments.Id "${sqlGeneralDepartmentId}" was not found in the fetched Departments set — cannot verify its parent hierarchy.` };
  }
  const hierarchyValidation = await validateDepartmentHierarchy(
    placementResult.placement.parentChain,
    placementResult.placement.missingParent,
    targetDepartment.companyId,
    (id) => prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId: id }, select: { department: { select: { companyId: true } } } }).then((m) => (m ? { companyId: m.department.companyId } : null))
  );
  const hierarchyFailure = describeHierarchyValidationFailure(hierarchyValidation);
  if (hierarchyFailure) return { ok: false, reason: `Parent-hierarchy validation failed: ${hierarchyFailure}` };

  const existing = await prisma.sqlGeneralDepartmentMapping.findUnique({ where: { sqlGeneralDepartmentId } });
  if (existing && existing.departmentId !== targetDepartmentId) {
    return { ok: false, reason: `SQLGeneral Departments.Id "${sqlGeneralDepartmentId}" is already mapped to a different Department (id="${existing.departmentId}") — remove that mapping first if it should change.` };
  }
  if (existing) {
    // Idempotent re-approval of the exact same pair — safe no-op, not an error.
    return { ok: true, mapping: { sqlGeneralDepartmentId, departmentId: existing.departmentId, approvedById: existing.approvedById, approvedAt: existing.approvedAt } };
  }

  if (!confirmMultipleMapping) {
    const otherMappingCount = await prisma.sqlGeneralDepartmentMapping.count({ where: { departmentId: targetDepartmentId } });
    if (otherMappingCount > 0) {
      return { ok: false, reason: `Department "${targetDepartmentId}" already has ${otherMappingCount} other approved SQLGeneral mapping(s) — this would create a many-to-one mapping. Pass confirmMultipleMapping: true to proceed; this is allowed, but never created without explicit confirmation.` };
    }
  }

  const created = await prisma.sqlGeneralDepartmentMapping.create({
    data: { sqlGeneralDepartmentId, departmentId: targetDepartmentId, approvedById },
  });
  return { ok: true, mapping: { sqlGeneralDepartmentId: created.sqlGeneralDepartmentId, departmentId: created.departmentId, approvedById: created.approvedById, approvedAt: created.approvedAt } };
}

// ─── Graph username backfill (existing Microsoft-linked users, no new login required) ─

export type BackfillAction =
  | "create_pending"
  | "recover_pending"
  | "no_change"
  | "conflicting_username_skipped"
  | "active_or_terminal_skipped"
  | "no_graph_username";

export interface BackfillCandidate {
  userId: string;
  graphId: string;
  currentStatus: SqlGeneralUserSyncStatus | null;
  currentUsername: string | null;
  graphUsername: string | null;
  action: BackfillAction;
}

export interface BackfillCounts {
  total: number;
  createPending: number;
  recoverPending: number;
  noChange: number;
  conflictingUsernameSkipped: number;
  activeOrTerminalSkipped: number;
  noGraphUsername: number;
}

function summarizeBackfillCandidates(candidates: BackfillCandidate[]): BackfillCounts {
  const counts: BackfillCounts = { total: candidates.length, createPending: 0, recoverPending: 0, noChange: 0, conflictingUsernameSkipped: 0, activeOrTerminalSkipped: 0, noGraphUsername: 0 };
  for (const c of candidates) {
    if (c.action === "create_pending") counts.createPending++;
    else if (c.action === "recover_pending") counts.recoverPending++;
    else if (c.action === "no_change") counts.noChange++;
    else if (c.action === "conflicting_username_skipped") counts.conflictingUsernameSkipped++;
    else if (c.action === "active_or_terminal_skipped") counts.activeOrTerminalSkipped++;
    else if (c.action === "no_graph_username") counts.noGraphUsername++;
  }
  return counts;
}

/**
 * Pure classification — no network, no writes. Matches each Graph identity
 * to a local user EXCLUSIVELY via `graphId === User.microsoftUserId` (never
 * email/UPN/name); a Graph row with no matching local user is silently
 * dropped (not a candidate at all, not an error).
 *
 *   - no attempt row + a Graph username        -> create_pending (safe: enqueueOrRecoverSqlGeneralUserSync's own "no row" branch)
 *   - SKIPPED_NO_USERNAME + a Graph username    -> recover_pending (safe: that function's own recovery branch)
 *   - PENDING, current username null            -> recover_pending (same function fills it in place)
 *   - PENDING, current username === Graph's     -> no_change
 *   - PENDING, current username DIFFERS         -> conflicting_username_skipped — NEVER applied; this is the
 *     one case enqueueOrRecoverSqlGeneralUserSync would normally overwrite silently when called from login
 *     (a fresh, authoritative live value), which is correct for THAT caller but NOT safe for a bulk backfill
 *     comparing against a snapshot — so this classifier deliberately withholds it rather than ever calling that
 *     function for this case.
 *   - PROCESSING / SUCCEEDED / FAILED_PERMANENT -> active_or_terminal_skipped — never touched, regardless of
 *     what Graph says, preserving active and successful sync states exactly as required.
 *   - no onPremisesSamAccountName on the Graph side -> no_graph_username (nothing to offer either way).
 */
async function classifySqlGeneralUsernameBackfill(identities: GraphUserIdentity[]): Promise<BackfillCandidate[]> {
  const graphIds = identities.map((i) => i.graphId);
  if (graphIds.length === 0) return [];

  const users = await prisma.user.findMany({ where: { microsoftUserId: { in: graphIds } }, select: { id: true, microsoftUserId: true } });
  const userIdByGraphId = new Map(users.filter((u) => u.microsoftUserId).map((u) => [u.microsoftUserId as string, u.id]));

  const localUserIds = Array.from(userIdByGraphId.values());
  const attempts = localUserIds.length > 0 ? await prisma.sqlGeneralUserSyncAttempt.findMany({ where: { userId: { in: localUserIds } } }) : [];
  const attemptByUserId = new Map(attempts.map((a) => [a.userId, a]));

  const candidates: BackfillCandidate[] = [];
  for (const identity of identities) {
    const userId = userIdByGraphId.get(identity.graphId);
    if (!userId) continue; // no corresponding local user — never guessed, just irrelevant

    const attempt = attemptByUserId.get(userId) ?? null;
    const currentStatus = attempt?.status ?? null;
    const currentUsername = attempt?.sqlGeneralUsername ?? null;
    const graphUsername = identity.onPremisesSamAccountName;

    if (!graphUsername) {
      candidates.push({ userId, graphId: identity.graphId, currentStatus, currentUsername, graphUsername: null, action: "no_graph_username" });
      continue;
    }
    if (!attempt) {
      candidates.push({ userId, graphId: identity.graphId, currentStatus: null, currentUsername: null, graphUsername, action: "create_pending" });
      continue;
    }
    if (attempt.status === SqlGeneralUserSyncStatus.SKIPPED_NO_USERNAME) {
      candidates.push({ userId, graphId: identity.graphId, currentStatus, currentUsername, graphUsername, action: "recover_pending" });
      continue;
    }
    if (attempt.status === SqlGeneralUserSyncStatus.PENDING) {
      if (!currentUsername) {
        candidates.push({ userId, graphId: identity.graphId, currentStatus, currentUsername, graphUsername, action: "recover_pending" });
      } else if (currentUsername === graphUsername) {
        candidates.push({ userId, graphId: identity.graphId, currentStatus, currentUsername, graphUsername, action: "no_change" });
      } else {
        candidates.push({ userId, graphId: identity.graphId, currentStatus, currentUsername, graphUsername, action: "conflicting_username_skipped" });
      }
      continue;
    }
    // PROCESSING / SUCCEEDED / FAILED_PERMANENT
    candidates.push({ userId, graphId: identity.graphId, currentStatus, currentUsername, graphUsername, action: "active_or_terminal_skipped" });
  }
  return candidates;
}

export type BackfillPreviewResult = { ok: true; candidates: BackfillCandidate[]; counts: BackfillCounts } | { ok: false; reason: string };

/** Read-only — fetches Graph identities + classifies, never writes. Admin-facing "what would the backfill do" report (REQUIRED #4). */
export async function previewSqlGeneralUsernameBackfill(): Promise<BackfillPreviewResult> {
  const identityResult = await fetchAllGraphUserIdentities();
  if (!identityResult.ok) return { ok: false, reason: `Graph identity fetch failed: ${identityResult.reason}${identityResult.status ? ` (status ${identityResult.status})` : ""}` };
  const candidates = await classifySqlGeneralUsernameBackfill(identityResult.identities);
  return { ok: true, candidates, counts: summarizeBackfillCandidates(candidates) };
}

export type BackfillApplyResult = { ok: true; applied: number; counts: BackfillCounts } | { ok: false; reason: string };

/**
 * Re-runs the same classification, then applies ONLY the two provably-safe
 * actions (create_pending / recover_pending) via the EXISTING, unmodified
 * enqueueOrRecoverSqlGeneralUserSync — the exact same function login
 * already calls. Every other action (no_change, conflicting_username_skipped,
 * active_or_terminal_skipped, no_graph_username) is never written. Never
 * touches User, never touches Department/Company/DepartmentMembership.
 */
export async function applySqlGeneralUsernameBackfill(): Promise<BackfillApplyResult> {
  const preview = await previewSqlGeneralUsernameBackfill();
  if (!preview.ok) return preview;

  let applied = 0;
  for (const candidate of preview.candidates) {
    if (candidate.action === "create_pending" || candidate.action === "recover_pending") {
      await enqueueOrRecoverSqlGeneralUserSync(candidate.userId, candidate.graphUsername);
      applied++;
    }
  }
  return { ok: true, applied, counts: preview.counts };
}
