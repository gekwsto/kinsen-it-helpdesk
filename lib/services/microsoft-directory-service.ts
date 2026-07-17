/**
 * This file implements Operation B of TicketApp's Microsoft Directory Sync
 * module — see docs/microsoft-graph-directory-sync.md for the full picture.
 * The module has one purpose (keep DepartmentMembership/
 * MicrosoftDepartmentMapping aligned with Microsoft/Entra) split across two
 * Graph operations that necessarily use different tokens and permissions:
 *
 *   Operation A — current user department sync
 *   (lib/services/microsoft-department-sync-service.ts, NOT this file):
 *      - Endpoint: GET /me?$select=...,department,...
 *      - Token: delegated, the signed-in user's own token
 *      - Permission: User.Read (already granted, already working)
 *      - Reads ONLY that one user's own department, once per login.
 *      - Unaffected by anything in this file — different token, different
 *        cache (none), different trigger.
 *
 *   Operation B — admin-triggered company directory discovery (this file):
 *      - Endpoint: GET /users?$select=id,department&$top=999, paged
 *      - Token: application (client-credentials), via getAppOnlyGraphAccessToken()
 *      - Permission: Directory.Read.All (Application, admin consent required)
 *      - Reads every user in the tenant to collect distinct department
 *        strings, purely to populate the admin mapping dropdown. Never
 *        called from the login path, never called on page render or modal
 *        open — only from the admin-triggered POST .../sync route.
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
  "https://graph.microsoft.com/v1.0/users?$select=id,department&$top=999";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 200; // guards against a runaway @odata.nextLink loop; ~200k users at $top=999

export type DirectoryFetchFailureReason =
  | "unauthorized"
  | "no_permission"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response";

export type DirectoryFetchResult =
  | { ok: true; values: string[] }
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

interface GraphUsersPage {
  value: Array<{ department?: string | null }>;
  "@odata.nextLink"?: string;
}

function isGraphUsersPage(data: unknown): data is GraphUsersPage {
  return typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).value);
}

/**
 * Pages through the tenant's users collecting distinct, trimmed, non-empty
 * `department` values. Never throws — every failure is a typed result.
 */
export async function fetchAllGraphUserDepartments(): Promise<DirectoryFetchResult> {
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch {
    return { ok: false, reason: "network_error" };
  }

  const values = new Set<string>();
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
      // .trim() only strips leading/trailing whitespace (a common source of
      // silent exact-match failures against MicrosoftDepartmentMapping) —
      // it never alters internal characters/casing, so the stored value
      // still matches what Graph will send at login time.
      const dept = typeof user.department === "string" ? user.department.trim() : "";
      if (dept) values.add(dept);
    }

    url = data["@odata.nextLink"];
  }

  return { ok: true, values: Array.from(values).sort((a, b) => a.localeCompare(b)) };
}

export interface DirectorySyncSummary {
  discovered: number;
  added: number;
  updated: number;
  staled: number;
}

export type DirectorySyncResult =
  | ({ ok: true } & DirectorySyncSummary)
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

/**
 * Admin-triggered only. Fetches the current distinct department values from
 * Graph and upserts them into the local cache table — never deletes a row,
 * only marks previously-seen values inactive if a later sync no longer sees
 * them, so the cache is audit-safe and self-healing on the next sync.
 */
export async function syncMicrosoftDirectoryDepartments(): Promise<DirectorySyncResult> {
  const result = await fetchAllGraphUserDepartments();
  if (!result.ok) {
    console.warn("[microsoft-directory] Directory sync failed", { reason: result.reason, status: result.status });
    return result;
  }

  const seen = new Set(result.values);
  const existing = await prisma.microsoftDirectoryDepartmentValue.findMany({
    select: { value: true, isActive: true },
  });
  const existingByValue = new Map(existing.map((row) => [row.value, row.isActive]));

  let added = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const value of seen) {
      const priorIsActive = existingByValue.get(value);
      if (priorIsActive === undefined) {
        await tx.microsoftDirectoryDepartmentValue.create({
          data: { value, firstSeenAt: new Date(), lastSeenAt: new Date(), isActive: true },
        });
        added++;
      } else {
        await tx.microsoftDirectoryDepartmentValue.update({
          where: { value },
          data: { lastSeenAt: new Date(), isActive: true },
        });
        if (!priorIsActive) updated++;
      }
    }

    const staleValues = existing.filter((row) => row.isActive && !seen.has(row.value)).map((row) => row.value);
    if (staleValues.length > 0) {
      await tx.microsoftDirectoryDepartmentValue.updateMany({
        where: { value: { in: staleValues } },
        data: { isActive: false },
      });
    }
  });

  const staled = existing.filter((row) => row.isActive && !seen.has(row.value)).length;

  console.log("[microsoft-directory] Directory sync completed", {
    discovered: seen.size,
    added,
    updated,
    staled,
  });

  return { ok: true, discovered: seen.size, added, updated, staled };
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
  const latest = await prisma.microsoftDirectoryDepartmentValue.aggregate({
    _max: { updatedAt: true },
  });
  return { values: rows.map((r) => r.value), lastSyncedAt: latest._max.updatedAt ?? null };
}
