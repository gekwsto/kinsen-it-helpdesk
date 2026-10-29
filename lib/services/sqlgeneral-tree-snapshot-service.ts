/**
 * Owns the persistent, daily-refreshed SQLGeneral Manager Explorer
 * snapshot — the DB-backed replacement for building the manager-first
 * tree live on every page load. Never reimplements the hierarchy
 * algorithm itself: every rebuild calls getSqlGeneralOrganizationTree()
 * (lib/services/sqlgeneral-organization-tree-service.ts) verbatim and
 * persists whatever it returns. Completely independent of SQLGeneral
 * Sync (SQLGENERAL_SYNC_ENABLED) and of Project Request's own
 * findSqlGeneralUserByUsername lookups (lib/services/project-request-service.ts)
 * — neither reads nor writes anything this module owns.
 *
 * Mirrors lib/services/organization-sync-orchestrator.ts's own
 * lock/run-lifecycle shape (atomic compare-and-set singleton lock, one
 * audit row per attempt), deliberately NOT reusing that module's
 * OrganizationSyncLock — this is a read-only SQLGeneral rebuild, a
 * completely different subsystem from the Microsoft-Graph-sourced
 * Company/Department writes that lock guards.
 */
import { prisma } from "@/lib/prisma";
import { Prisma, SqlGeneralTreeSnapshotStatus, SqlGeneralTreeSnapshotTrigger } from "@prisma/client";
import { getSqlGeneralOrganizationTree, type SqlGeneralManagerTreeNode, type UnresolvedSqlGeneralUser, type UnresolvedSqlGeneralManagerLink } from "@/lib/services/sqlgeneral-organization-tree-service";

const SINGLETON_LOCK_ID = "singleton";
/** Same 30-minute convention as OrganizationSyncLock's own STALE_LOCK_TIMEOUT_MS — a lock older than this is treated as a crashed run, not a real in-progress one. */
const STALE_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * "Daily, targeting 03:00 Europe/Athens" — deliberately NOT a rolling
 * interval (e.g. "20 hours since last success"), which would drift earlier
 * every day and eventually refresh at an arbitrary, ever-changing local
 * time. Instead this is a genuine CALENDAR-DAY gate: due once the current
 * moment's Europe/Athens calendar date differs from the last successful
 * snapshot's Europe/Athens calendar date AND the current Europe/Athens
 * local hour has reached TARGET_HOUR. The CRON worker itself still fires
 * frequently (hourly — see vercel.json/docker-compose.yml, the SAME
 * existing frequent-trigger-plus-idempotent-handler idiom every other
 * worker in this codebase already uses), but a REAL rebuild only actually
 * happens on the one invocation per day where this returns true.
 *
 * Uses Intl.DateTimeFormat with an explicit IANA timeZone rather than a
 * fixed UTC offset specifically so Athens' EET/EEST daylight-saving
 * transitions are handled correctly automatically (Node's ICU data), with
 * no manual offset arithmetic:
 *   - Spring-forward (clocks jump 02:59:59 EET -> 04:00:00 EEST): the
 *     03:00-03:59 local hour never occurs that one day. This guard still
 *     self-heals — it simply becomes due at the next real hour >=
 *     TARGET_HOUR (effectively 04:00 that day), never skipping the whole
 *     day and never erroring.
 *   - Fall-back (clocks repeat 03:00:00 EEST -> 03:00:00 EET an hour
 *     later): the 03:00-03:59 local hour occurs TWICE. The first
 *     occurrence (if the calendar date differs from the last success)
 *     triggers the refresh and updates the "last success" date; the
 *     second occurrence sees the SAME calendar date already recorded and
 *     correctly stays not-due — never a second same-day rebuild.
 *
 * A snapshot that has NEVER succeeded even once is always due immediately,
 * regardless of hour — there is no "previous day" to compare against, and
 * waiting for the next 03:00 window after first deploy would leave the
 * Manager Explorer showing "not yet initialized" for up to 24h for no
 * reason; the CRON path builds one as soon as it can, same as it always
 * could via a manual ADMIN refresh.
 */
const TARGET_TIMEZONE = "Europe/Athens";
const TARGET_HOUR = 3;

function athensDateKeyAndHour(d: Date): { dateKey: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TARGET_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { dateKey: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Exported for direct, deterministic testing (including DST transition days) — see its own doc comment above and scripts/test-sqlgeneral-tree-snapshot.ts. */
export function isDueForDailySqlGeneralTreeRefresh(now: Date, lastSuccessfulCompletedAt: Date | null): boolean {
  if (!lastSuccessfulCompletedAt) return true;
  const nowInfo = athensDateKeyAndHour(now);
  if (nowInfo.hour < TARGET_HOUR) return false;
  const lastInfo = athensDateKeyAndHour(lastSuccessfulCompletedAt);
  return lastInfo.dateKey !== nowInfo.dateKey;
}

export interface TreeSnapshotPayload {
  roots: SqlGeneralManagerTreeNode[];
  unresolvedUsers: UnresolvedSqlGeneralUser[];
  unresolvedManagerLinks: UnresolvedSqlGeneralManagerLink[];
}

function countNodes(nodes: SqlGeneralManagerTreeNode[]): number {
  let total = 0;
  for (const n of nodes) total += 1 + countNodes(n.children);
  return total;
}

/**
 * Only transitions a run's row OUT of RUNNING if it is STILL actually
 * RUNNING at the moment of this write — the guard against a "late
 * completion": a worker whose lock already went stale and was reclaimed
 * (acquireSqlGeneralTreeSnapshotLock below) is presumed crashed, but isn't
 * guaranteed to have actually stopped executing — it may wake up later and
 * try to persist its own (now-superseded) result. Every write that
 * transitions a run away from RUNNING — the normal SUCCEEDED/FAILED
 * completion below, AND the stale-lock cleanup's own abandonment write —
 * goes through this SAME conditional `updateMany`, so whichever one
 * reaches Postgres first wins atomically and the other becomes a
 * documented no-op (count 0) rather than silently overwriting a result
 * that's already been superseded.
 */
async function transitionRunIfStillRunning(runId: string, data: Prisma.SqlGeneralOrganizationTreeSnapshotUpdateInput): Promise<boolean> {
  const result = await prisma.sqlGeneralOrganizationTreeSnapshot.updateMany({ where: { id: runId, status: SqlGeneralTreeSnapshotStatus.RUNNING }, data });
  return result.count === 1;
}

/**
 * Atomic compare-and-set acquire — same idiom as
 * acquireOrganizationSyncLock, applied to this feature's OWN singleton
 * lock row. A lock left over from a crashed process (older than
 * STALE_LOCK_TIMEOUT_MS) is force-released first, so one crash can't
 * permanently wedge future refreshes — and the abandoned run's own row
 * (which would otherwise stay RUNNING forever, with no completedAt, since
 * the crashed process never reached its own finally block) is marked
 * FAILED via transitionRunIfStillRunning, so the run history honestly
 * reflects that the attempt died rather than silently vanishing from view.
 */
async function acquireSqlGeneralTreeSnapshotLock(runId: string): Promise<boolean> {
  await prisma.sqlGeneralTreeSnapshotLock.upsert({
    where: { id: SINGLETON_LOCK_ID },
    update: {},
    create: { id: SINGLETON_LOCK_ID },
  });

  const staleThreshold = new Date(Date.now() - STALE_LOCK_TIMEOUT_MS);
  const currentLock = await prisma.sqlGeneralTreeSnapshotLock.findUnique({ where: { id: SINGLETON_LOCK_ID } });
  const lockIsStale = !!(currentLock?.isLocked && currentLock.lockedAt && currentLock.lockedAt < staleThreshold);

  if (lockIsStale) {
    const released = await prisma.sqlGeneralTreeSnapshotLock.updateMany({
      where: { id: SINGLETON_LOCK_ID, isLocked: true, lockedAt: { lt: staleThreshold } },
      data: { isLocked: false, lockedAt: null, runId: null },
    });
    // Only mark the abandoned run FAILED if OUR force-release is the one
    // that actually fired (count === 1) — otherwise another process beat
    // us to it and will have already handled (or will handle) the same
    // cleanup, so this never double-reports/races on the same abandonment.
    if (released.count === 1 && currentLock?.runId) {
      await transitionRunIfStillRunning(currentLock.runId, {
        status: SqlGeneralTreeSnapshotStatus.FAILED,
        completedAt: new Date(),
        lastError: "Abandoned — the refresh lock expired (the worker likely crashed or was killed) before this attempt completed.",
      });
    }
  }

  const result = await prisma.sqlGeneralTreeSnapshotLock.updateMany({
    where: { id: SINGLETON_LOCK_ID, isLocked: false },
    data: { isLocked: true, lockedAt: new Date(), runId },
  });
  return result.count === 1;
}

async function releaseSqlGeneralTreeSnapshotLock(runId: string): Promise<void> {
  // Only releases if this run still holds the lock — never clears a lock
  // acquired by a later run (defensive, mirrors releaseOrganizationSyncLock).
  await prisma.sqlGeneralTreeSnapshotLock.updateMany({
    where: { id: SINGLETON_LOCK_ID, runId },
    data: { isLocked: false, lockedAt: null, runId: null },
  });
}

export async function isSqlGeneralTreeSnapshotRefreshRunning(): Promise<boolean> {
  const lock = await prisma.sqlGeneralTreeSnapshotLock.findUnique({ where: { id: SINGLETON_LOCK_ID } });
  if (!lock?.isLocked) return false;
  if (lock.lockedAt && Date.now() - lock.lockedAt.getTime() > STALE_LOCK_TIMEOUT_MS) return false;
  return true;
}

/** The row every normal page load actually reads — the most recent fully-built, validated snapshot. Never a RUNNING or FAILED row, by construction (see this file's header). */
export async function getLatestSuccessfulSqlGeneralTreeSnapshot() {
  return prisma.sqlGeneralOrganizationTreeSnapshot.findFirst({
    where: { status: SqlGeneralTreeSnapshotStatus.SUCCEEDED },
    orderBy: { completedAt: "desc" },
  });
}

/** The most recent attempt regardless of outcome — so the admin status UI can show "last attempt failed at Xpm" even while an older SUCCEEDED snapshot is still what's actually served. */
export async function getLatestSqlGeneralTreeSnapshotRun() {
  return prisma.sqlGeneralOrganizationTreeSnapshot.findFirst({ orderBy: { startedAt: "desc" } });
}

export interface RefreshSqlGeneralTreeSnapshotResult {
  skipped: boolean;
  skipReason?: string;
  ok?: boolean;
  runId?: string;
  reason?: string;
}

/**
 * The single entry point for both the daily CRON worker and the ADMIN
 * manual-refresh button. Builds a COMPLETE new tree via
 * getSqlGeneralOrganizationTree() (never a second hierarchy algorithm)
 * before writing anything — the row starts RUNNING, and only transitions
 * to SUCCEEDED (with the full payload attached in that SAME update) once
 * the build has fully succeeded. A build failure flags this row FAILED
 * and returns — it NEVER touches the previous SUCCEEDED row, so the last
 * known-good snapshot served by getLatestSuccessfulSqlGeneralTreeSnapshot
 * is always preserved automatically.
 *
 * `force: true` (manual refresh only) skips the "still fresh" staleness
 * guard but NEVER skips the lock — a manual click while a refresh is
 * already running (CRON or another manual click) is reported as
 * `skipped`, never started concurrently.
 */
export async function refreshSqlGeneralOrganizationTreeSnapshot(opts: {
  trigger: SqlGeneralTreeSnapshotTrigger;
  triggeredById?: string;
  force?: boolean;
}): Promise<RefreshSqlGeneralTreeSnapshotResult> {
  if (!opts.force) {
    const latest = await getLatestSuccessfulSqlGeneralTreeSnapshot();
    if (!isDueForDailySqlGeneralTreeRefresh(new Date(), latest?.completedAt ?? null)) {
      return { skipped: true, skipReason: "A successful snapshot already exists for today (Europe/Athens) — not yet due for its next daily refresh." };
    }
  }

  const run = await prisma.sqlGeneralOrganizationTreeSnapshot.create({
    data: { status: SqlGeneralTreeSnapshotStatus.RUNNING, triggeredBy: opts.trigger, triggeredById: opts.triggeredById ?? null },
  });

  const acquired = await acquireSqlGeneralTreeSnapshotLock(run.id);
  if (!acquired) {
    await transitionRunIfStillRunning(run.id, { status: SqlGeneralTreeSnapshotStatus.FAILED, completedAt: new Date(), lastError: "Another SQLGeneral tree snapshot refresh is already running." });
    return { skipped: true, skipReason: "Another SQLGeneral tree snapshot refresh is already running." };
  }

  try {
    const result = await getSqlGeneralOrganizationTree();
    if (!result.ok) {
      const applied = await transitionRunIfStillRunning(run.id, { status: SqlGeneralTreeSnapshotStatus.FAILED, completedAt: new Date(), lastError: result.reason });
      if (!applied) return { skipped: false, ok: false, runId: run.id, reason: "This refresh attempt was abandoned (its lock expired) before its failure could be recorded." };
      return { skipped: false, ok: false, runId: run.id, reason: result.reason };
    }

    const payload: TreeSnapshotPayload = { roots: result.roots, unresolvedUsers: result.unresolvedUsers, unresolvedManagerLinks: result.unresolvedManagerLinks };
    const applied = await transitionRunIfStillRunning(run.id, {
      status: SqlGeneralTreeSnapshotStatus.SUCCEEDED,
      completedAt: new Date(),
      treeData: payload as unknown as Prisma.InputJsonValue,
      rootCount: result.roots.length,
      nodeCount: countNodes(result.roots),
      unresolvedUserCount: result.unresolvedUsers.length,
      unresolvedManagerLinkCount: result.unresolvedManagerLinks.length,
    });
    // This run's own lock already went stale and was reclaimed by a newer
    // attempt (acquireSqlGeneralTreeSnapshotLock already marked this row
    // FAILED on that run's behalf) WHILE this build was still in flight —
    // a genuine "late completion." Never overwrite that outcome: report
    // honestly that this specific attempt's result was superseded, rather
    // than claiming ok: true while the DB disagrees.
    if (!applied) return { skipped: false, ok: false, runId: run.id, reason: "This refresh attempt was abandoned (its lock expired) before it could persist its result." };
    return { skipped: false, ok: true, runId: run.id };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await transitionRunIfStillRunning(run.id, { status: SqlGeneralTreeSnapshotStatus.FAILED, completedAt: new Date(), lastError: reason });
    return { skipped: false, ok: false, runId: run.id, reason };
  } finally {
    await releaseSqlGeneralTreeSnapshotLock(run.id);
  }
}
