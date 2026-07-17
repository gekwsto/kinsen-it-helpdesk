/**
 * This file implements Operation B of TicketApp's Microsoft Directory Sync
 * module — see docs/microsoft-graph-directory-sync.md for the full picture.
 * The module has one purpose (keep DepartmentMembership/
 * MicrosoftDepartmentMapping aligned with Microsoft/Entra) split across two
 * Graph operations that necessarily use different tokens and permissions:
 *
 *   Operation A — current user department/job-title sync
 *   (lib/services/microsoft-department-sync-service.ts, NOT this file):
 *      - Endpoint: GET /me?$select=...,department,jobTitle
 *      - Token: delegated, the signed-in user's own token
 *      - Permission: User.Read (already granted, already working)
 *      - Reads ONLY that one user's own department/jobTitle, once per login.
 *      - Also opportunistically upserts the single value it saw into the
 *        caches below (upsertDiscoveredMicrosoftDirectoryValue) — zero extra
 *        Graph calls, zero extra permissions, since the data's already in
 *        hand from /me.
 *      - Unaffected by anything else in this file — different token,
 *        different trigger.
 *
 *   Operation B — admin-triggered company directory discovery (this file):
 *      - Endpoint: GET /users?$select=id,department,jobTitle&$top=999, paged
 *      - Token: application (client-credentials), via getAppOnlyGraphAccessToken()
 *      - Permission: Directory.Read.All (Application, admin consent required)
 *      - Reads every user in the tenant to collect distinct department AND
 *        jobTitle values in one pass, purely to populate the admin mapping
 *        dropdowns. Never called from the login path, never called on page
 *        render or modal open — only from the admin-triggered
 *        POST .../values/sync route.
 *
 * Directory.Read.All must be added and admin-consented on the SAME app
 * registration already used for GRAPH_CLIENT_ID / GRAPH_TENANT_ID /
 * GRAPH_CLIENT_SECRET (today only consented for Mail.Read/Send/ReadWrite,
 * used by lib/microsoft-graph.ts for mailbox polling) — see
 * docs/microsoft-graph-directory-sync.md for the exact Entra admin center
 * steps. Without that consent, `GET /users` returns 403, handled here as
 * `no_permission` (never thrown) — this has NO effect on Operation A, since
 * they use different tokens and different permissions entirely, and normal
 * login never requires Directory.Read.All.
 */
import { prisma } from "@/lib/prisma";
import { getAppOnlyGraphAccessToken } from "@/lib/microsoft-graph";

const GRAPH_USERS_PAGE_URL =
  "https://graph.microsoft.com/v1.0/users?$select=id,department,jobTitle&$top=999";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 200; // guards against a runaway @odata.nextLink loop; ~200k users at $top=999

export type DirectoryFetchFailureReason =
  | "unauthorized"
  | "no_permission"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response";

export interface DirectoryFetchValues {
  departments: string[];
  jobTitles: string[];
}

export type DirectoryFetchResult =
  | { ok: true; values: DirectoryFetchValues }
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

interface GraphUsersPage {
  value: Array<{ department?: string | null; jobTitle?: string | null }>;
  "@odata.nextLink"?: string;
}

function isGraphUsersPage(data: unknown): data is GraphUsersPage {
  return typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).value);
}

/**
 * Pages through the tenant's users in ONE combined scan, collecting
 * distinct, trimmed, non-empty `department` AND `jobTitle` values. Never
 * throws — every failure is a typed result.
 */
export async function fetchAllGraphUserDirectoryValues(): Promise<DirectoryFetchResult> {
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch {
    return { ok: false, reason: "network_error" };
  }

  const departments = new Set<string>();
  const jobTitles = new Set<string>();
  let url: string | undefined = GRAPH_USERS_PAGE_URL;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    pages++;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "network_error" };
    }

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
    if (!isGraphUsersPage(data)) return { ok: false, reason: "malformed_response" };

    for (const user of data.value) {
      // .trim() only strips leading/trailing whitespace — never alters
      // internal characters/casing, so stored values still match what
      // Graph will send at login time.
      const dept = typeof user.department === "string" ? user.department.trim() : "";
      if (dept) departments.add(dept);
      const title = typeof user.jobTitle === "string" ? user.jobTitle.trim() : "";
      if (title) jobTitles.add(title);
    }

    url = data["@odata.nextLink"];
  }

  return {
    ok: true,
    values: {
      departments: Array.from(departments).sort((a, b) => a.localeCompare(b)),
      jobTitles: Array.from(jobTitles).sort((a, b) => a.localeCompare(b)),
    },
  };
}

// Minimal structural shape shared by the two directory-value cache tables
// (MicrosoftDirectoryDepartmentValue / MicrosoftDirectoryJobTitleValue —
// byte-for-byte identical schema) so the sync logic below is written once,
// not duplicated per table. Both Prisma delegates satisfy this shape.
interface DirectoryValueDelegate {
  findMany(args: { select: { value: true; isActive: true } }): Promise<Array<{ value: string; isActive: boolean }>>;
  upsert(args: {
    where: { value: string };
    create: { value: string; firstSeenAt: Date; lastSeenAt: Date; isActive: boolean };
    update: { lastSeenAt: Date; isActive: boolean };
  }): Promise<unknown>;
  updateMany(args: { where: { value: { in: string[] } }; data: { isActive: boolean } }): Promise<{ count: number }>;
  aggregate(args: { _max: { updatedAt: true } }): Promise<{ _max: { updatedAt: Date | null } }>;
}

interface TableSyncSummary {
  added: number;
  updated: number;
  staled: number;
}

/**
 * Upserts every currently-seen value (create if new, refresh lastSeenAt +
 * reactivate if previously stale) and marks previously-active-but-now-
 * unseen values inactive — never deletes a row, so history/audit trail is
 * preserved and the cache self-heals on the next sync. Each upsert is
 * already atomic on its own; not wrapped in a cross-row transaction (a
 * partial run on a rare mid-sync failure just self-heals on the next
 * admin-triggered sync, same non-destructive philosophy as the rest of this
 * feature).
 */
async function syncDirectoryValueTable(delegate: DirectoryValueDelegate, seen: Set<string>): Promise<TableSyncSummary> {
  const existing = await delegate.findMany({ select: { value: true, isActive: true } });
  const existingByValue = new Map(existing.map((row) => [row.value, row.isActive]));

  let added = 0;
  let updated = 0;
  for (const value of seen) {
    const priorIsActive = existingByValue.get(value);
    await delegate.upsert({
      where: { value },
      create: { value, firstSeenAt: new Date(), lastSeenAt: new Date(), isActive: true },
      update: { lastSeenAt: new Date(), isActive: true },
    });
    if (priorIsActive === undefined) added++;
    else if (!priorIsActive) updated++;
  }

  const staleValues = existing.filter((row) => row.isActive && !seen.has(row.value)).map((row) => row.value);
  if (staleValues.length > 0) {
    await delegate.updateMany({ where: { value: { in: staleValues } }, data: { isActive: false } });
  }

  return { added, updated, staled: staleValues.length };
}

export interface DirectorySyncSummary {
  discoveredDepartments: number;
  addedDepartments: number;
  updatedDepartments: number;
  staledDepartments: number;
  discoveredJobTitles: number;
  addedJobTitles: number;
  updatedJobTitles: number;
  staledJobTitles: number;
}

export type DirectorySyncResult =
  | ({ ok: true } & DirectorySyncSummary)
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

/**
 * Admin-triggered only. Fetches the current distinct department + jobTitle
 * values from Graph in one combined scan and upserts both cache tables.
 */
export async function syncMicrosoftDirectoryValues(): Promise<DirectorySyncResult> {
  const result = await fetchAllGraphUserDirectoryValues();
  if (!result.ok) {
    console.warn("[microsoft-directory] Directory sync failed", { reason: result.reason, status: result.status });
    return result;
  }

  const seenDepartments = new Set(result.values.departments);
  const seenJobTitles = new Set(result.values.jobTitles);

  const deptSummary = await syncDirectoryValueTable(prisma.microsoftDirectoryDepartmentValue, seenDepartments);
  const titleSummary = await syncDirectoryValueTable(prisma.microsoftDirectoryJobTitleValue, seenJobTitles);

  console.log("[microsoft-directory] Directory sync completed", {
    discoveredDepartments: seenDepartments.size,
    ...deptSummary,
    discoveredJobTitles: seenJobTitles.size,
    ...titleSummary,
  });

  return {
    ok: true,
    discoveredDepartments: seenDepartments.size,
    addedDepartments: deptSummary.added,
    updatedDepartments: deptSummary.updated,
    staledDepartments: deptSummary.staled,
    discoveredJobTitles: seenJobTitles.size,
    addedJobTitles: titleSummary.added,
    updatedJobTitles: titleSummary.updated,
    staledJobTitles: titleSummary.staled,
  };
}

export async function getCachedDirectoryDepartmentValues(): Promise<{
  values: string[];
  lastSyncedAt: Date | null;
}> {
  const rows = await prisma.microsoftDirectoryDepartmentValue.findMany({
    where: { isActive: true },
    orderBy: { value: "asc" },
    select: { value: true },
  });
  const latest = await prisma.microsoftDirectoryDepartmentValue.aggregate({ _max: { updatedAt: true } });
  return { values: rows.map((r) => r.value), lastSyncedAt: latest._max.updatedAt ?? null };
}

export async function getCachedDirectoryJobTitleValues(): Promise<{
  values: string[];
  lastSyncedAt: Date | null;
}> {
  const rows = await prisma.microsoftDirectoryJobTitleValue.findMany({
    where: { isActive: true },
    orderBy: { value: "asc" },
    select: { value: true },
  });
  const latest = await prisma.microsoftDirectoryJobTitleValue.aggregate({ _max: { updatedAt: true } });
  return { values: rows.map((r) => r.value), lastSyncedAt: latest._max.updatedAt ?? null };
}

/**
 * Called from Operation A (login /me sync) to opportunistically cache the
 * single department/jobTitle value just observed for the signed-in user —
 * zero extra Graph calls, zero extra permissions (uses data already fetched
 * via delegated User.Read). This is how the dropdown cache can fill in over
 * time even on a tenant that never grants Directory.Read.All. Never writes
 * an empty value; trims before storing/comparing.
 */
export async function upsertDiscoveredMicrosoftDirectoryValue(
  kind: "department" | "jobTitle",
  value: string
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return;

  const delegate: DirectoryValueDelegate =
    kind === "department" ? prisma.microsoftDirectoryDepartmentValue : prisma.microsoftDirectoryJobTitleValue;

  await delegate.upsert({
    where: { value: trimmed },
    create: { value: trimmed, firstSeenAt: new Date(), lastSeenAt: new Date(), isActive: true },
    update: { lastSeenAt: new Date(), isActive: true },
  });
}
