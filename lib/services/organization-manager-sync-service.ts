/**
 * Manager/reporting-line sync — the second, independent half of "sync the
 * whole organization" (the first half, user properties + department
 * membership, is lib/services/organization-directory-sync-service.ts).
 *
 * ── CORRECTED Graph contract (production correction pass) ──────────────────
 * `GET /users/{id}/manager` does **NOT** support Application permissions —
 * this is Microsoft Graph's own documented contract for the "Get manager"
 * operation (its permissions table lists Delegated: User.Read.All,
 * User.ReadBasic.All, Directory.Read.All, Directory.AccessAsUser.All, and
 * explicitly **no** Application permission entry at all). An earlier version
 * of this service called that endpoint with an app-only (client-credentials)
 * token — that call would 403/permission-fail against a REAL tenant
 * regardless of which application permission is granted, because the
 * endpoint itself doesn't accept an application token, not because a
 * specific scope was missing. No amount of additional permission grants
 * fixes an unsupported auth mode.
 *
 * `GET /users/{id}/directReports` (the reverse direction) DOES support
 * Application permissions: `User.Read.All` or `Directory.Read.All`. This app
 * registration already has Application `Directory.Read.All` consented (used
 * by lib/services/microsoft-directory-service.ts) — **no additional
 * permission is required** for this service to work.
 *
 * This service therefore inverts the relationship: it calls
 * `directReports` on every known tenant user (candidate manager) and writes
 * `directReport.managerId = manager.id` for each edge — never calls
 * `/manager` at all. `candidateManagers` is the FULL raw directory-scan
 * result (lib/services/organization-directory-sync-service.ts's
 * `DirectoryRawUserRecord[]`), including users excluded from the synced set
 * (guests/service accounts) — an excluded user can still legitimately be
 * someone's manager in Entra, and skipping their directReports call would
 * silently misclassify real employees as roots.
 *
 * ── Atomic publish ───────────────────────────────────────────────────────
 * The ENTIRE new manager-edge graph is computed in memory first (every
 * candidate manager's directReports fetched, resolved, cycle-checked) before
 * any database write happens. If ANY candidate manager's fetch hard-fails
 * (exhausts fetchWithGraphRetry's retries — a genuine Graph/network
 * failure, not a per-record data-quality issue), the WHOLE run aborts
 * BEFORE the write phase: `published: false`, zero rows touched, the
 * previously published snapshot remains completely intact and is exactly
 * what every read API/visualization continues to serve. Only when the
 * fetch phase completes for every candidate manager does the single
 * publish transaction run — one Postgres transaction writing every
 * resolved user's `managerId` in one commit, so no reader can ever observe
 * a mix of old and new manager edges (Postgres transaction isolation, not a
 * batched multi-transaction approximation).
 */
import { prisma } from "@/lib/prisma";
import { getAppOnlyGraphAccessToken, GraphConfigurationError } from "@/lib/microsoft-graph";
import { fetchWithGraphRetry, type GraphRetryOptions } from "@/lib/microsoft-graph-retry";
import type { DirectorySyncFailureReason, DirectoryRawUserRecord } from "@/lib/services/organization-directory-sync-service";

const REQUEST_TIMEOUT_MS = 15000;
const CONCURRENCY_LIMIT = 5; // small, controlled worker pool — never unbounded Promise.all
const MAX_CHAIN_DEPTH = 50; // safety cap when walking the resolved manager chain for cycle detection
const MAX_PAGES_PER_MANAGER = 20; // guards a runaway @odata.nextLink loop for one manager's own directReports page
const DIRECT_REPORTS_PAGE_SIZE = 999;
// Prisma's default interactive-transaction timeout (5000ms) is far too
// short for a single transaction writing every synced user's managerId in
// one commit — raised explicitly for this reason. A very large tenant (tens
// of thousands of users) may need this raised further, or the publish step
// split into a chunked-but-still-single-visible-commit strategy (e.g.
// Postgres advisory locking + a single bulk UPDATE...FROM VALUES) — a real,
// documented scaling boundary of this straightforward implementation, not a
// silently ignored one.
const PUBLISH_TRANSACTION_TIMEOUT_MS = 120000;
const PUBLISH_TRANSACTION_MAX_WAIT_MS = 10000;

/** Bounded-concurrency map — runs at most `limit` promises at once, never `Promise.all` over the full list. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type DirectReportsFetchResult =
  | { ok: true; reportMicrosoftUserIds: string[] }
  | { ok: false; reason: DirectorySyncFailureReason; status?: number };

/**
 * Paginated `GET /users/{id}/directReports?$select=id` for ONE candidate
 * manager — only the `id` field is requested (the only property this
 * inversion needs). A 404 on the manager itself (deleted between the
 * directory scan and this call) is treated as "zero reports", not a hard
 * failure — the manager row simply vanished, which isn't this call's
 * problem to solve.
 */
async function fetchDirectReports(
  token: string,
  managerMicrosoftUserId: string,
  retryOptions?: GraphRetryOptions
): Promise<DirectReportsFetchResult> {
  const reportMicrosoftUserIds: string[] = [];
  let url: string | undefined = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(managerMicrosoftUserId)}/directReports?$select=id&$top=${DIRECT_REPORTS_PAGE_SIZE}`;
  let pages = 0;

  while (url && pages < MAX_PAGES_PER_MANAGER) {
    pages++;
    let response: Response;
    try {
      response = await fetchWithGraphRetry(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, retryOptions);
    } catch {
      return { ok: false, reason: "network_error" };
    }

    if (response.status === 404) return { ok: true, reportMicrosoftUserIds };
    if (!response.ok) {
      if (response.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
      if (response.status === 403) return { ok: false, reason: "no_permission", status: 403 };
      if (response.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
      return { ok: false, reason: "server_error", status: response.status };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, reason: "malformed_response" };
    }
    if (typeof data !== "object" || data === null || !Array.isArray((data as Record<string, unknown>).value)) {
      return { ok: false, reason: "malformed_response" };
    }
    for (const item of (data as { value: unknown[] }).value) {
      const id = typeof item === "object" && item !== null ? (item as Record<string, unknown>).id : undefined;
      if (typeof id === "string" && id) reportMicrosoftUserIds.push(id);
    }
    url = (data as Record<string, unknown>)["@odata.nextLink"] as string | undefined;
  }

  return { ok: true, reportMicrosoftUserIds };
}

interface ResolvedEdge {
  managerMicrosoftUserId: string;
  managerIsExcluded: boolean;
}

/**
 * Walks UP the candidate manager chain using the FINAL resolved map (not a
 * DB round trip per check) with an explicit visited Set and
 * MAX_CHAIN_DEPTH guard — true if assigning `candidateManagerId` as
 * `childId`'s manager would create a cycle, including the trivial
 * self-manager case.
 */
function wouldCreateCycle(childId: string, candidateManagerId: string, managerIdByDbUserId: Map<string, string | null>): boolean {
  if (childId === candidateManagerId) return true;
  const visited = new Set<string>([childId]);
  let current: string | null = candidateManagerId;
  let depth = 0;
  while (current) {
    if (visited.has(current)) return true;
    if (depth >= MAX_CHAIN_DEPTH) return true;
    visited.add(current);
    current = managerIdByDbUserId.get(current) ?? null;
    depth++;
  }
  return false;
}

export interface ManagerSyncOutcome {
  ok: boolean;
  /** True only if the atomic publish transaction actually committed a new snapshot. False on any hard fetch failure OR a write-phase failure — in both cases the previous snapshot is untouched. */
  published: boolean;
  reason?: DirectorySyncFailureReason | "partial_fetch_failure";
  usersScanned: number;
  usersUpdated: number;
  usersSkipped: number;
  errorCount: number;
  /** Users whose real Entra manager exists but was excluded from the synced set (guest/service account) — a distinct, non-error signal, not folded into errorCount. */
  managerNotSyncedCount: number;
}

/**
 * `candidateManagers` is every raw user from the SAME sync run's directory
 * scan (lib/services/organization-directory-sync-service.ts), not just the
 * validated subset — see the file header for why. Never throws; every
 * failure path (including "the fetch phase partially failed") is a typed,
 * `published: false` result.
 */
export interface ManagerSyncOptions {
  /** Overrides fetchDirectReports's retry/backoff timing — exposed only so tests can avoid real multi-second exponential backoff delays when deliberately simulating a persistent Graph failure; production callers should never need this. */
  retryOptions?: GraphRetryOptions;
}

export async function runOrganizationManagerSync(candidateManagers: DirectoryRawUserRecord[], options: ManagerSyncOptions = {}): Promise<ManagerSyncOutcome> {
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch (err) {
    const reason: DirectorySyncFailureReason = err instanceof GraphConfigurationError ? "configuration_error" : "network_error";
    return { ok: false, published: false, reason, usersScanned: 0, usersUpdated: 0, usersSkipped: 0, errorCount: 0, managerNotSyncedCount: 0 };
  }

  if (candidateManagers.length === 0) {
    return { ok: true, published: true, usersScanned: 0, usersUpdated: 0, usersSkipped: 0, errorCount: 0, managerNotSyncedCount: 0 };
  }

  // Deterministic order so a duplicate-edge conflict (the same report
  // claimed by two managers — a real Entra data anomaly, since `manager` is
  // single-valued) always resolves the same way run over run: first
  // encountered, by microsoftUserId sort order, wins.
  const orderedCandidates = [...candidateManagers].sort((a, b) => a.microsoftUserId.localeCompare(b.microsoftUserId));

  let hardFailureCount = 0;
  const fetchResults = await mapWithConcurrency(orderedCandidates, CONCURRENCY_LIMIT, async (manager) => {
    const result = await fetchDirectReports(token, manager.microsoftUserId, options.retryOptions);
    return { manager, result };
  });

  const edgesByReportMicrosoftUserId = new Map<string, ResolvedEdge>();
  let duplicateEdgeConflicts = 0;
  let selfManagerRejections = 0;

  for (const { manager, result } of fetchResults) {
    if (!result.ok) {
      hardFailureCount++;
      console.warn("[organization-manager-sync] Failed to fetch directReports", { microsoftUserId: manager.microsoftUserId, reason: result.reason, status: result.status });
      continue;
    }
    for (const reportId of result.reportMicrosoftUserIds) {
      if (reportId === manager.microsoftUserId) {
        selfManagerRejections++;
        console.warn("[organization-manager-sync] Rejected self-manager edge reported by Graph", { microsoftUserId: manager.microsoftUserId });
        continue;
      }
      if (edgesByReportMicrosoftUserId.has(reportId)) {
        duplicateEdgeConflicts++;
        console.warn("[organization-manager-sync] Duplicate manager edge (report claimed by more than one manager) — keeping the first, deterministic by sort order", {
          reportMicrosoftUserId: reportId,
          conflictingManagerMicrosoftUserId: manager.microsoftUserId,
        });
        continue;
      }
      edgesByReportMicrosoftUserId.set(reportId, { managerMicrosoftUserId: manager.microsoftUserId, managerIsExcluded: manager.isExcluded });
    }
  }

  // ── Fetch-phase gate: ANY hard Graph failure aborts the whole publish. ──
  // This is deliberately stricter than "isolate one bad record and keep
  // going" (which still applies to per-record data-quality issues like
  // self-manager/duplicate-edge above) — a manager whose directReports call
  // genuinely failed means the computed graph is INCOMPLETE, and publishing
  // an incomplete graph would silently misrepresent real employees as roots
  // (a worse outcome than just keeping yesterday's known-good snapshot).
  if (hardFailureCount > 0) {
    return {
      ok: false,
      published: false,
      reason: "partial_fetch_failure",
      usersScanned: candidateManagers.length,
      usersUpdated: 0,
      usersSkipped: 0,
      errorCount: hardFailureCount,
      managerNotSyncedCount: 0,
    };
  }

  // ── Resolve edges to LOCAL dbUserIds — never a raw Entra id written. ──
  const dbUserIdByMicrosoftUserId = new Map(orderedCandidates.filter((u) => u.dbUserId).map((u) => [u.microsoftUserId, u.dbUserId as string]));

  // Bulk-loaded once (not per-edge) — the companyId each candidate was
  // placed under by Microsoft Directory Sync (lib/services/
  // organization-directory-sync-service.ts), used only to reject a
  // cross-company manager edge below; never touches organizational
  // placement itself.
  const allDbUserIds = orderedCandidates.map((u) => u.dbUserId).filter((id): id is string => !!id);
  const companyRows = allDbUserIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: allDbUserIds } }, select: { id: true, companyId: true } }) : [];
  const companyIdByDbUserId = new Map(companyRows.map((u) => [u.id, u.companyId]));

  interface Resolution {
    managerId: string | null;
    managerExcludedFromSync: boolean;
  }
  const resolutionByDbUserId = new Map<string, Resolution>();
  let managerNotSyncedCount = 0;
  let managerNotInSyncSetCount = 0;
  let crossCompanyRejections = 0;

  for (const user of orderedCandidates) {
    if (!user.dbUserId) continue; // excluded user — no local row to update
    const edge = edgesByReportMicrosoftUserId.get(user.microsoftUserId);
    if (!edge) {
      // Never claimed as anyone's direct report — a legitimate possible
      // root, NOT an error. Classification of whether this root is
      // "expected" happens in the unmapped-report service, not here.
      resolutionByDbUserId.set(user.dbUserId, { managerId: null, managerExcludedFromSync: false });
      continue;
    }
    if (edge.managerIsExcluded) {
      // Real manager relationship exists in Entra, but the manager was
      // excluded from our synced set (guest/service account) — distinct
      // from "no manager at all".
      resolutionByDbUserId.set(user.dbUserId, { managerId: null, managerExcludedFromSync: true });
      managerNotSyncedCount++;
      continue;
    }
    const localManagerId = dbUserIdByMicrosoftUserId.get(edge.managerMicrosoftUserId);
    if (!localManagerId) {
      // Manager was validated (not excluded) but has no local row — an
      // isolated per-row upsert failure for that specific manager during
      // the directory-sync stage. Same downstream treatment as "not synced".
      resolutionByDbUserId.set(user.dbUserId, { managerId: null, managerExcludedFromSync: true });
      managerNotInSyncSetCount++;
      continue;
    }
    // Cross-company guard: a manager relationship spanning two different
    // Companies (e.g. a misconfigured tenant, or a company-merger transition
    // period in Entra) is rejected outright — never silently accepted just
    // because the target id resolves. Only rejects when BOTH sides have a
    // known, DIFFERENT companyId; a null companyId on either side (not yet
    // synced this run, or a pre-migration legacy row) is not treated as a
    // mismatch — there's nothing concrete to reject against.
    const reportCompanyId = companyIdByDbUserId.get(user.dbUserId);
    const managerCompanyId = companyIdByDbUserId.get(localManagerId);
    if (reportCompanyId && managerCompanyId && reportCompanyId !== managerCompanyId) {
      crossCompanyRejections++;
      console.warn("[organization-manager-sync] Rejected cross-company manager edge, publishing null instead", {
        reportMicrosoftUserId: user.microsoftUserId,
        managerMicrosoftUserId: edge.managerMicrosoftUserId,
      });
      resolutionByDbUserId.set(user.dbUserId, { managerId: null, managerExcludedFromSync: false });
      continue;
    }
    resolutionByDbUserId.set(user.dbUserId, { managerId: localManagerId, managerExcludedFromSync: false });
  }

  // Cycle detection over the FINAL resolved map.
  let cycleRejections = 0;
  const managerIdLookup = new Map<string, string | null>(Array.from(resolutionByDbUserId.entries()).map(([id, r]) => [id, r.managerId]));
  for (const [dbUserId, resolution] of resolutionByDbUserId) {
    if (resolution.managerId && wouldCreateCycle(dbUserId, resolution.managerId, managerIdLookup)) {
      cycleRejections++;
      resolutionByDbUserId.set(dbUserId, { managerId: null, managerExcludedFromSync: false });
      console.warn("[organization-manager-sync] Rejected cyclic manager chain, publishing null instead", { dbUserId, candidateManagerId: resolution.managerId });
    }
  }

  // ── Atomic publish: one transaction, one commit, or none at all. ──
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const [dbUserId, resolution] of resolutionByDbUserId) {
          await tx.user.update({
            where: { id: dbUserId },
            data: { managerId: resolution.managerId, managerExcludedFromSync: resolution.managerExcludedFromSync, organizationSyncedAt: new Date() },
          });
        }
      },
      { timeout: PUBLISH_TRANSACTION_TIMEOUT_MS, maxWait: PUBLISH_TRANSACTION_MAX_WAIT_MS }
    );
  } catch (err) {
    console.warn("[organization-manager-sync] Publish transaction failed — previous snapshot remains active, nothing was written", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      published: false,
      reason: "server_error",
      usersScanned: candidateManagers.length,
      usersUpdated: 0,
      usersSkipped: 0,
      errorCount: hardFailureCount + 1,
      managerNotSyncedCount: 0,
    };
  }

  return {
    ok: true,
    published: true,
    usersScanned: candidateManagers.length,
    usersUpdated: resolutionByDbUserId.size,
    usersSkipped: candidateManagers.length - orderedCandidates.filter((u) => u.dbUserId).length,
    errorCount: duplicateEdgeConflicts + selfManagerRejections + cycleRejections + managerNotInSyncSetCount + crossCompanyRejections,
    managerNotSyncedCount,
  };
}
