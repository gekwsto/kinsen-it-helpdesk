/**
 * Entry point for every organization sync — the admin "Sync organization"
 * button, the future initial-full-sync bootstrap, and the periodic
 * relationship-only refresh all go through here, never call the directory/
 * manager sync services directly. Owns: the mutual-exclusion lock (so two
 * syncs can never run concurrently), the `OrganizationSyncRun` audit row
 * lifecycle, and post-sync cache invalidation.
 */
import { prisma } from "@/lib/prisma";
import { OrganizationSyncStatus, OrganizationSyncType } from "@prisma/client";
import { runOrganizationDirectorySync, type DirectoryRawUserRecord } from "@/lib/services/organization-directory-sync-service";
import { runOrganizationManagerSync } from "@/lib/services/organization-manager-sync-service";
import { invalidateOrganizationTreeCache } from "@/lib/services/organization-tree-service";

const STALE_LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — a lock older than this is treated as a crashed run, not a real in-progress one

const SINGLETON_LOCK_ID = "singleton";

/**
 * Atomic compare-and-set acquire: only succeeds if the singleton row is
 * currently unlocked, via a single conditional `updateMany` (race-safe
 * under concurrent admin clicks — Postgres serializes the two competing
 * UPDATEs, only one can match `isLocked: false`). A lock left over from a
 * crashed process (older than STALE_LOCK_TIMEOUT_MS) is force-released
 * first, so one crash can't permanently wedge future syncs.
 */
async function acquireOrganizationSyncLock(runId: string): Promise<boolean> {
  await prisma.organizationSyncLock.upsert({
    where: { id: SINGLETON_LOCK_ID },
    update: {},
    create: { id: SINGLETON_LOCK_ID },
  });

  const staleThreshold = new Date(Date.now() - STALE_LOCK_TIMEOUT_MS);
  await prisma.organizationSyncLock.updateMany({
    where: { id: SINGLETON_LOCK_ID, isLocked: true, lockedAt: { lt: staleThreshold } },
    data: { isLocked: false, lockedAt: null, runId: null },
  });

  const result = await prisma.organizationSyncLock.updateMany({
    where: { id: SINGLETON_LOCK_ID, isLocked: false },
    data: { isLocked: true, lockedAt: new Date(), runId },
  });
  return result.count === 1;
}

async function releaseOrganizationSyncLock(runId: string): Promise<void> {
  // Only releases if this run still holds the lock — never clears a lock
  // acquired by a later run (defensive, shouldn't happen given the
  // acquire/release pairing below, but cheap insurance).
  await prisma.organizationSyncLock.updateMany({
    where: { id: SINGLETON_LOCK_ID, runId },
    data: { isLocked: false, lockedAt: null, runId: null },
  });
}

/**
 * `RELATIONSHIP_REFRESH` (manager sync without a fresh directory scan) has
 * no per-run raw-directory-scan result to draw candidate managers from —
 * this rebuilds an equivalent candidate list from the CURRENT DB state
 * instead of re-fetching `GET /users`. Trade-off, explicit: this can never
 * discover a currently-excluded (guest/service) Entra manager, since such a
 * user was never given a local row in the first place — only a `FULL` sync
 * (which re-scans the raw directory, excluded users included) can detect
 * MANAGER_NOT_SYNCED. Acceptable because RELATIONSHIP_REFRESH's whole
 * purpose is a cheaper refresh of reporting lines among ALREADY-known
 * users, not a full re-discovery pass.
 */
async function buildCandidateManagersFromDb(): Promise<DirectoryRawUserRecord[]> {
  const users = await prisma.user.findMany({
    where: { microsoftUserId: { not: null } },
    select: { id: true, microsoftUserId: true },
  });
  return users.map((u) => ({ microsoftUserId: u.microsoftUserId as string, isExcluded: false, dbUserId: u.id }));
}

export interface OrganizationSyncRunResult {
  runId: string;
  status: OrganizationSyncStatus;
  alreadyRunning: boolean;
  usersScanned: number;
  usersUpdated: number;
  usersSkipped: number;
  errorCount: number;
  /** Whether the manager-sync stage's atomic publish actually committed a new snapshot this run. Null if the manager stage didn't run at all (type=INCREMENTAL). False means the previous snapshot is still what every read API serves — never a "half-applied" state. */
  managerHierarchyPublished: boolean | null;
}

/**
 * `FULL` = directory sync (user properties + department membership) THEN
 * manager sync (fed the SAME run's raw directory-scan result, including
 * excluded users). `INCREMENTAL` = directory sync only (cheaper — property
 * refresh, no manager traversal). `RELATIONSHIP_REFRESH` = manager sync
 * only, candidate list rebuilt from the current DB (see
 * buildCandidateManagersFromDb). All three share this same lock/
 * run-lifecycle machinery.
 */
export async function runOrganizationSync(
  type: OrganizationSyncType,
  triggeredById?: string
): Promise<OrganizationSyncRunResult> {
  const run = await prisma.organizationSyncRun.create({
    data: { type, status: OrganizationSyncStatus.RUNNING, triggeredById },
  });

  const acquired = await acquireOrganizationSyncLock(run.id);
  if (!acquired) {
    await prisma.organizationSyncRun.update({
      where: { id: run.id },
      data: {
        status: OrganizationSyncStatus.FAILED,
        completedAt: new Date(),
        lastError: "Another organization sync is already running.",
      },
    });
    return { runId: run.id, status: OrganizationSyncStatus.FAILED, alreadyRunning: true, usersScanned: 0, usersUpdated: 0, usersSkipped: 0, errorCount: 0, managerHierarchyPublished: null };
  }

  let usersScanned = 0;
  let usersUpdated = 0;
  let usersSkipped = 0;
  let errorCount = 0;
  let hardFailureReason: string | null = null;
  let managerHierarchyPublished: boolean | null = null;
  let directoryRawUsers: DirectoryRawUserRecord[] = [];

  try {
    if (type === OrganizationSyncType.FULL || type === OrganizationSyncType.INCREMENTAL) {
      const directoryOutcome = await runOrganizationDirectorySync();
      if (!directoryOutcome.ok) {
        hardFailureReason = `Directory sync failed: ${directoryOutcome.reason}`;
      } else {
        usersScanned += directoryOutcome.usersScanned;
        usersUpdated += directoryOutcome.usersUpdated;
        usersSkipped += directoryOutcome.usersSkipped;
        errorCount += directoryOutcome.errorCount;
        directoryRawUsers = directoryOutcome.rawUsers;
      }
    }

    // Only proceed to the (separate, independent) manager sync if the
    // directory stage didn't hard-fail — a directory-stage permission/
    // config error almost certainly means the manager stage would fail
    // identically (same app-only token), so this avoids a second identical
    // failure being logged.
    if (!hardFailureReason && (type === OrganizationSyncType.FULL || type === OrganizationSyncType.RELATIONSHIP_REFRESH)) {
      const candidateManagers = type === OrganizationSyncType.FULL ? directoryRawUsers : await buildCandidateManagersFromDb();
      const managerOutcome = await runOrganizationManagerSync(candidateManagers);
      managerHierarchyPublished = managerOutcome.published;
      if (!managerOutcome.ok) {
        hardFailureReason = `Manager sync failed: ${managerOutcome.reason}`;
      } else {
        usersUpdated += managerOutcome.usersUpdated;
        usersSkipped += managerOutcome.usersSkipped;
        errorCount += managerOutcome.errorCount;
      }
    }
  } catch (err) {
    hardFailureReason = err instanceof Error ? err.message : String(err);
  } finally {
    await releaseOrganizationSyncLock(run.id);
  }

  const status: OrganizationSyncStatus = hardFailureReason
    ? OrganizationSyncStatus.FAILED
    : errorCount > 0
      ? OrganizationSyncStatus.PARTIAL
      : OrganizationSyncStatus.SUCCEEDED;

  await prisma.organizationSyncRun.update({
    where: { id: run.id },
    data: {
      status,
      completedAt: new Date(),
      usersScanned,
      usersUpdated,
      usersSkipped,
      errorCount,
      lastError: hardFailureReason,
    },
  });

  // Only invalidate the read-side cache when something was ACTUALLY
  // published — a hard-failed manager-sync stage (managerHierarchyPublished
  // === false) means nothing changed in the DB, so the cache (still holding
  // the previous, still-accurate snapshot) must NOT be dropped; invalidating
  // it here would force an unnecessary rebuild that produces byte-identical
  // output, and — more importantly — a cache miss during a narrow race
  // window is exactly the kind of "what if two things read at once"
  // scenario this guard avoids reasoning about.
  const somethingPublished = status === OrganizationSyncStatus.SUCCEEDED || status === OrganizationSyncStatus.PARTIAL;
  if (somethingPublished) {
    invalidateOrganizationTreeCache();
  }

  return { runId: run.id, status, alreadyRunning: false, usersScanned, usersUpdated, usersSkipped, errorCount, managerHierarchyPublished };
}

export async function getLatestOrganizationSyncRun() {
  return prisma.organizationSyncRun.findFirst({ orderBy: { startedAt: "desc" } });
}

export async function isOrganizationSyncRunning(): Promise<boolean> {
  const lock = await prisma.organizationSyncLock.findUnique({ where: { id: SINGLETON_LOCK_ID } });
  if (!lock?.isLocked) return false;
  // A lock that's gone stale is reported as "not running" so the UI doesn't
  // show a perpetual spinner for a crashed run — the next real sync attempt
  // force-releases it via acquireOrganizationSyncLock above.
  if (lock.lockedAt && Date.now() - lock.lockedAt.getTime() > STALE_LOCK_TIMEOUT_MS) return false;
  return true;
}
