/**
 * Tenant-wide user directory sync (Operation D of TicketApp's Microsoft
 * integration, alongside Operation A/B/C documented in
 * lib/services/microsoft-directory-service.ts's header comment) — the
 * user-property half of "sync the whole organization". The manager/
 * directReports half is a separate, deliberately independent service:
 * lib/services/organization-manager-sync-service.ts.
 *
 * Permission: `GET /users` (Application) is documented by Microsoft Graph to
 * accept any of `User.Read.All`, `User.ReadWrite.All`, `Directory.Read.All`,
 * `Directory.ReadWrite.All`. This app registration already has Application
 * `Directory.Read.All` consented (used by microsoft-directory-service.ts) —
 * that already satisfies this call. **No additional permission is required
 * for this to work.** Uses the same app-only token flow as every other
 * application-permission Graph call in this codebase
 * (getAppOnlyGraphAccessToken, lib/microsoft-graph.ts).
 *
 * Deliberately does NOT sync User.role (global role) in bulk — that's a
 * login-time-specific decision (handleMicrosoftJwtSignIn /
 * syncMicrosoftUserDepartment) reviewed one user at a time as they actually
 * sign in; silently bulk-changing potentially thousands of users' roles
 * during a background sync would be a much bigger, unreviewed blast radius
 * than this feature asks for. Department MEMBERSHIP linking (not role) IS
 * synced here, by calling the exact same resolveDepartmentMemberships /
 * syncDepartmentMemberships functions the login path already uses — no
 * parallel mapping logic.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { AuthProvider } from "@prisma/client";
import { getAppOnlyGraphAccessToken, GraphConfigurationError } from "@/lib/microsoft-graph";
import { fetchWithGraphRetry } from "@/lib/microsoft-graph-retry";
import { resolveDepartmentMemberships } from "@/lib/services/microsoft-mapping-service";
import { syncDepartmentMemberships } from "@/lib/services/department-membership-service";
import type { MicrosoftIdentityClaims } from "@/types/department";

const GRAPH_USERS_SELECT = [
  "id",
  "displayName",
  "userPrincipalName",
  "mail",
  "accountEnabled",
  "userType",
  "department",
  "jobTitle",
  "companyName",
  "officeLocation",
  "employeeId",
  "employeeType",
].join(",");

const GRAPH_USERS_PAGE_URL = `https://graph.microsoft.com/v1.0/users?$select=${GRAPH_USERS_SELECT}&$top=999`;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 200; // same guard as microsoft-directory-service.ts — ~200k users at $top=999
const BATCH_SIZE = 200; // per-transaction batch — one bad batch never aborts the whole run

export interface GraphDirectoryUser {
  id: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
  mail?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  officeLocation?: string | null;
  employeeId?: string | null;
  employeeType?: string | null;
}

interface GraphUsersPage {
  value: GraphDirectoryUser[];
  "@odata.nextLink"?: string;
}

function isGraphUsersPage(data: unknown): data is GraphUsersPage {
  return typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).value);
}

export type DirectorySyncFailureReason =
  | "unauthorized"
  | "no_permission"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response"
  | "configuration_error";

export type FetchTenantUsersResult =
  | { ok: true; users: GraphDirectoryUser[] }
  | { ok: false; reason: DirectorySyncFailureReason; status?: number };

/**
 * Pages through the FULL tenant user directory with the field set this
 * feature needs, following every `@odata.nextLink` (never assumes a single
 * page) and retrying 429/5xx via fetchWithGraphRetry. Never throws — every
 * failure is a typed result, matching this codebase's existing Graph-call
 * convention (see microsoft-directory-service.ts).
 */
export async function fetchAllTenantUsers(): Promise<FetchTenantUsersResult> {
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch (err) {
    if (err instanceof GraphConfigurationError) return { ok: false, reason: "configuration_error" };
    return { ok: false, reason: "network_error" };
  }

  const users: GraphDirectoryUser[] = [];
  let url: string | undefined = GRAPH_USERS_PAGE_URL;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    pages++;
    let response: Response;
    try {
      response = await fetchWithGraphRetry(url, {
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

    users.push(...data.value);
    url = data["@odata.nextLink"];
  }

  return { ok: true, users };
}

export type DirectoryUserValidationFailureReason =
  | "guest_or_service_account"
  | "missing_id"
  | "missing_email_and_upn";

export type DirectoryUserValidationResult =
  | { valid: true; user: GraphDirectoryUser; email: string }
  | { valid: false; reason: DirectoryUserValidationFailureReason; userId?: string };

/**
 * Pure, unit-testable validation — never touches the DB or network. Filters
 * out guest/service accounts (per the brief's explicit "don't display these"
 * requirement) and any record missing the fields this app actually requires
 * (a stable id to upsert by, and something email-shaped to satisfy User's
 * required unique `email` column — `mail` first, `userPrincipalName` as a
 * fallback, since Graph's `mail` is null for some real, non-guest accounts
 * e.g. mailbox-less service identities that still report userType "Member").
 */
export function validateDirectoryUser(raw: GraphDirectoryUser): DirectoryUserValidationResult {
  if (!raw.id) return { valid: false, reason: "missing_id" };
  // Entra's own userType values are "Member" or "Guest" — anything that
  // isn't "Member" is treated as non-employee and excluded, matching the
  // brief's "guest/service accounts must not appear" requirement. A missing
  // userType is NOT rejected here (some tenants don't populate it for every
  // account) — absence isn't evidence of being a guest.
  if (raw.userType && raw.userType !== "Member") {
    return { valid: false, reason: "guest_or_service_account", userId: raw.id };
  }
  const email = raw.mail?.trim() || raw.userPrincipalName?.trim() || "";
  if (!email) return { valid: false, reason: "missing_email_and_upn", userId: raw.id };
  return { valid: true, user: raw, email };
}

export interface DirectoryBatchSyncCounts {
  updated: number;
  created: number;
  skipped: number;
  errors: number;
  /** dbUserId + the raw Graph fields needed for department-membership resolution below — captured here (not re-queried afterward) since User has no persisted scalar column for Entra's raw `department` string (only the resolved Department relation). */
  syncedForMembership: Array<{ dbUserId: string; microsoftUserId: string; email: string; name: string | null; department: string | null; jobTitle: string | null }>;
}

/**
 * Upserts one batch of already-validated users by `microsoftUserId` (the
 * stable Entra `oid` — never creates a duplicate account for an existing
 * user, matches the identity-anchor convention already established at
 * login). A brand-new tenant member with no prior TicketApp row gets a real
 * User row created here (authProvider MICROSOFT, no passwordHash) so the
 * organization tree can represent the whole tenant, not just people who've
 * already signed in — `isActive` is seeded from Entra's `accountEnabled` at
 * CREATE time only; an EXISTING row's `isActive` (a TicketApp-local
 * decision) is never touched by sync, mirroring how `avatarSource`/
 * `globalRoleSource` already protect their own fields from being silently
 * overwritten.
 */
async function upsertDirectoryUserBatch(
  tx: Prisma.TransactionClient,
  validated: Array<{ user: GraphDirectoryUser; email: string }>
): Promise<DirectoryBatchSyncCounts> {
  const counts: DirectoryBatchSyncCounts = { updated: 0, created: 0, skipped: 0, errors: 0, syncedForMembership: [] };

  for (const { user, email } of validated) {
    try {
      const existing = await tx.user.findUnique({ where: { microsoftUserId: user.id }, select: { id: true, name: true } });
      const commonFields = {
        name: user.displayName ?? undefined,
        jobTitle: user.jobTitle ?? undefined,
        employeeId: user.employeeId ?? undefined,
        employeeType: user.employeeType ?? undefined,
        entraAccountEnabled: user.accountEnabled ?? undefined,
        entraUserType: user.userType ?? undefined,
        organizationSyncedAt: new Date(),
      };

      let dbUserId: string;
      let name: string | null;
      if (existing) {
        await tx.user.update({ where: { id: existing.id }, data: commonFields });
        counts.updated++;
        dbUserId = existing.id;
        name = user.displayName ?? existing.name;
      } else {
        const created = await tx.user.create({
          data: {
            email,
            name: user.displayName ?? null,
            microsoftUserId: user.id,
            authProvider: AuthProvider.MICROSOFT,
            isActive: user.accountEnabled ?? true,
            jobTitle: user.jobTitle ?? null,
            employeeId: user.employeeId ?? null,
            employeeType: user.employeeType ?? null,
            entraAccountEnabled: user.accountEnabled ?? null,
            entraUserType: user.userType ?? null,
            organizationSyncedAt: new Date(),
          },
          select: { id: true, name: true },
        });
        counts.created++;
        dbUserId = created.id;
        name = created.name;
      }
      counts.syncedForMembership.push({ dbUserId, microsoftUserId: user.id, email, name, department: user.department ?? null, jobTitle: user.jobTitle ?? null });
    } catch (err) {
      // A single bad record (e.g. a race against a concurrent email-uniqueness
      // conflict) is isolated and counted, never aborts the whole batch — the
      // outer per-batch transaction still commits everything else that
      // succeeded before this row, since each user is its own try/catch, not
      // a single all-or-nothing statement.
      counts.errors++;
      console.warn("[organization-directory-sync] Failed to upsert directory user", {
        microsoftUserId: user.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return counts;
}

/**
 * Every user seen in the raw `GET /users` scan, whether or not it passed
 * `validateDirectoryUser` — the manager-sync stage
 * (organization-manager-sync-service.ts) needs the FULL candidate-manager
 * set, not just the validated/synced subset, because an excluded
 * guest/service account can still legitimately be someone's manager in
 * Entra. `dbUserId` is null for anything that wasn't upserted (excluded, or
 * an isolated per-row upsert failure).
 */
export interface DirectoryRawUserRecord {
  microsoftUserId: string;
  isExcluded: boolean;
  dbUserId: string | null;
}

export interface DirectorySyncOutcome {
  ok: boolean;
  reason?: DirectorySyncFailureReason;
  usersScanned: number;
  usersUpdated: number;
  usersSkipped: number;
  errorCount: number;
  rawUsers: DirectoryRawUserRecord[];
}

/**
 * Full pipeline: fetch (paginated + retried) -> validate (guest/service
 * filter, missing-field guard) -> batched transactional upsert -> per-user
 * department-membership resolution via the EXISTING, tested
 * resolveDepartmentMemberships/syncDepartmentMemberships functions (never a
 * second mapping implementation). Never throws for an expected Graph/DB
 * failure — returns a typed outcome the orchestrator writes into
 * OrganizationSyncRun.
 */
export async function runOrganizationDirectorySync(): Promise<DirectorySyncOutcome> {
  const fetchResult = await fetchAllTenantUsers();
  if (!fetchResult.ok) {
    return { ok: false, reason: fetchResult.reason, usersScanned: 0, usersUpdated: 0, usersSkipped: 0, errorCount: 0, rawUsers: [] };
  }

  let usersUpdated = 0;
  let usersCreated = 0;
  let usersSkipped = 0;
  let errorCount = 0;
  const syncedForMembership: DirectoryBatchSyncCounts["syncedForMembership"] = [];

  const validatedUsers: Array<{ user: GraphDirectoryUser; email: string }> = [];
  const excludedMicrosoftUserIds = new Set<string>();
  for (const raw of fetchResult.users) {
    const result = validateDirectoryUser(raw);
    if (!result.valid) {
      usersSkipped++;
      if (raw.id) excludedMicrosoftUserIds.add(raw.id);
      continue;
    }
    validatedUsers.push({ user: result.user, email: result.email });
  }

  for (let i = 0; i < validatedUsers.length; i += BATCH_SIZE) {
    const batch = validatedUsers.slice(i, i + BATCH_SIZE);
    try {
      const counts = await prisma.$transaction(async (tx) => upsertDirectoryUserBatch(tx, batch));
      usersUpdated += counts.updated;
      usersCreated += counts.created;
      errorCount += counts.errors;
      syncedForMembership.push(...counts.syncedForMembership);
    } catch (err) {
      // The whole batch's transaction failed to commit at all (vs. an
      // isolated per-row error inside a committed batch, handled above) —
      // count every user in this batch as an error and move on to the next
      // batch, never aborting the entire tenant-wide run for one bad batch.
      errorCount += batch.length;
      console.warn("[organization-directory-sync] Batch transaction failed", {
        batchStart: i,
        batchSize: batch.length,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Department-membership resolution — reuses the exact same functions the
  // login path calls (lib/services/microsoft-mapping-service.ts,
  // lib/services/department-membership-service.ts), one user at a time,
  // sequentially (not Promise.all) to keep DB load predictable during a
  // potentially large batch. Uses the raw Graph `department`/`jobTitle`
  // values captured during the upsert above — User has no persisted scalar
  // column for the raw Entra department string (only the resolved
  // Department relation), so there is nothing to re-query here.
  for (const synced of syncedForMembership) {
    try {
      const claims: MicrosoftIdentityClaims = {
        oid: synced.microsoftUserId,
        email: synced.email,
        name: synced.name,
        department: synced.department,
        jobTitle: synced.jobTitle,
      };
      const resolved = await resolveDepartmentMemberships(claims);
      await syncDepartmentMemberships(synced.dbUserId, resolved);
    } catch (err) {
      errorCount++;
      console.warn("[organization-directory-sync] Failed to resolve department membership", {
        dbUserId: synced.dbUserId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const dbUserIdByMicrosoftUserId = new Map(syncedForMembership.map((s) => [s.microsoftUserId, s.dbUserId]));
  const rawUsers: DirectoryRawUserRecord[] = fetchResult.users
    .filter((u) => !!u.id)
    .map((u) => ({
      microsoftUserId: u.id,
      isExcluded: excludedMicrosoftUserIds.has(u.id),
      dbUserId: dbUserIdByMicrosoftUserId.get(u.id) ?? null,
    }));

  return {
    ok: true,
    usersScanned: fetchResult.users.length,
    usersUpdated: usersUpdated + usersCreated,
    usersSkipped,
    errorCount,
    rawUsers,
  };
}
