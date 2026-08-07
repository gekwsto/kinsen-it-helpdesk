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
import { AuthProvider, DepartmentRole, MembershipSource } from "@prisma/client";
import { getAppOnlyGraphAccessToken, GraphConfigurationError } from "@/lib/microsoft-graph";
import { fetchWithGraphRetry } from "@/lib/microsoft-graph-retry";
import { resolveDepartmentMemberships } from "@/lib/services/microsoft-mapping-service";
import { syncDepartmentMemberships, setPrimaryDepartmentMembership } from "@/lib/services/department-membership-service";
import { normalizeEmail } from "@/lib/services/email-identity";
import {
  createOrganizationResolutionCache,
  resolveOrganizationPlacement,
  type OrganizationResolutionCache,
} from "@/lib/services/organization-company-department-resolver";
import { getOrganizationDirectoryEligibility } from "@/lib/services/organization-directory-eligibility-service";
import type { MicrosoftIdentityClaims } from "@/types/department";

const GRAPH_USERS_SELECT = [
  "id",
  "displayName",
  "givenName",
  "surname",
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
  // Deliberately NOT "manager" here — that's a navigation property, not a
  // plain field; Graph's application-permission `/users` list endpoint
  // can't bulk-expand it (the documented reason
  // lib/services/organization-manager-sync-service.ts exists at all — see
  // its header comment). Manager/reporting-line resolution stays that
  // service's job, via the directReports inversion, never duplicated here.
].join(",");

const GRAPH_USERS_PAGE_URL = `https://graph.microsoft.com/v1.0/users?$select=${GRAPH_USERS_SELECT}&$top=999`;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 200; // same guard as microsoft-directory-service.ts — ~200k users at $top=999
// Purely a chunking size for predictable memory/logging during a large
// tenant scan — NOT a transactional unit. Each user is its own fully
// independent write (see upsertOneDirectoryUser's header comment for why a
// shared per-batch transaction was a real production incident: Postgres
// aborts an ENTIRE transaction on the first failing statement — 25P02 on
// every subsequent query — so one user hitting the lower(email) unique
// constraint silently rolled back everyone else's already-"successful"
// writes in the same batch too).
const BATCH_SIZE = 200;

export interface GraphDirectoryUser {
  id: string;
  displayName?: string | null;
  givenName?: string | null;
  surname?: string | null;
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
  | "domain_not_eligible"
  | "missing_id"
  | "missing_email_and_upn";

export type DirectoryUserValidationResult =
  | { valid: true; user: GraphDirectoryUser; email: string }
  | { valid: false; reason: DirectoryUserValidationFailureReason; userId?: string };

/**
 * Pure, unit-testable validation — never touches the DB or network. Filters
 * out guest/service accounts AND non-Kinsen-domain accounts (see
 * organization-directory-eligibility-service.ts — the SAME shared rule the
 * per-login Microsoft sync uses, so a user's eligibility can never diverge
 * between the two entry points), plus any record missing the fields this
 * app actually requires (a stable id to upsert by, and something
 * email-shaped to satisfy User's required unique `email` column).
 *
 * FIND-003 (docs/roadmap-handoff-register.md): organization sync now only
 * processes real `@<ALLOWED_EMAIL_DOMAIN>` identities — an existing local
 * user who no longer matches (or never did) is simply never touched by this
 * validation gate, exactly like a guest/service account already was; their
 * existing organizational data, memberships, and roles are left completely
 * alone (see upsertOneDirectoryUser — a record that fails validation here
 * never reaches the upsert at all).
 */
export function validateDirectoryUser(raw: GraphDirectoryUser): DirectoryUserValidationResult {
  if (!raw.id) return { valid: false, reason: "missing_id" };

  const eligibility = getOrganizationDirectoryEligibility({ userType: raw.userType, mail: raw.mail, userPrincipalName: raw.userPrincipalName });
  if (!eligibility.eligible) {
    // "not_member" keeps its established, already-tested reason name
    // ("guest_or_service_account") for backward compatibility with existing
    // callers/logs; "no_matching_domain" is the new FIND-003 reason.
    return {
      valid: false,
      reason: eligibility.reason === "not_member" ? "guest_or_service_account" : "domain_not_eligible",
      userId: raw.id,
    };
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
  /** dbUserId + the raw Graph fields needed for department-membership resolution below — captured here (not re-queried afterward) since User has no persisted scalar column for Entra's raw `department` string (only the resolved Department relation). resolvedDepartmentId is the primary-organizational placement (organization-company-department-resolver.ts's result) used for the canonical setPrimaryDepartmentMembership call. */
  syncedForMembership: Array<{ dbUserId: string; microsoftUserId: string; email: string; name: string | null; department: string | null; jobTitle: string | null; resolvedDepartmentId: string | null }>;
}

export type DirectoryUserSyncAction = "created" | "updated" | "linked" | "skipped";

interface DirectoryUserSyncResult {
  action: DirectoryUserSyncAction;
  dbUserId: string | null;
  name: string | null;
  department: string | null;
  jobTitle: string | null;
  companyName: string | null;
  /** The resolved primary-organizational Department id (placement.departmentId) — null only when the upsert itself failed (skipped). Used by the membership-resolution loop below to set the PRIMARY DepartmentMembership via setPrimaryDepartmentMembership; never written to User.departmentId directly here anymore. */
  resolvedDepartmentId: string | null;
  skipReason?: string;
}

/**
 * Upserts ONE already-validated directory user — a real bug, seen in
 * production, is why this is no longer done inside a shared
 * `prisma.$transaction` across a whole batch of users (see BATCH_SIZE's
 * comment above): Postgres aborts an ENTIRE transaction on the first
 * failing statement (a user hitting the `User_email_lower_key` functional
 * unique index via the bug fixed below) — every subsequent query in that
 * SAME transaction then fails with `25P02 current transaction is aborted`,
 * and because the per-user JS try/catch swallowed each of those errors
 * without re-throwing, Prisma went on to attempt a COMMIT on an aborted
 * transaction, silently rolling back every OTHER user's already-"successful"
 * write in that batch too — while the in-memory counts/syncedForMembership
 * still claimed they'd been persisted. That's what later surfaced as
 * `[organization-manager-sync] ... No record was found for an update`: the
 * manager-sync stage was handed dbUserIds for rows that were never actually
 * committed. Each call here now runs as its own independent statement
 * sequence against the plain `prisma` client (no shared tx), so a failure
 * for one user can never poison another's write.
 *
 * Identity resolution order — never trusts microsoftUserId alone:
 *   1. `microsoftUserId` (the stable Entra oid) — the primary anchor,
 *      exactly as before.
 *   2. Not found by oid? Fall back to a case-insensitive email match
 *      (lib/services/email-identity.ts's normalizeEmail — the same
 *      normalization every other User create/lookup path in this app
 *      already uses). This is the actual root-cause fix: a user who already
 *      exists locally (manual account, prior credentials sign-in, or a
 *      previous partial/failed sync) with this same email but no
 *      microsoftUserId linked yet is now LINKED (found + updated), never
 *      duplicated via `create`.
 *   3. Found by email but that row is already linked to a DIFFERENT
 *      microsoftUserId? A genuine data conflict (email reuse/migration, or
 *      bad tenant data) — NEVER silently reassigned (could merge two
 *      different people's history under one account). Skipped, logged with
 *      a safe reason for manual review, never a crash.
 *   4. Not found by oid or email — create.
 *
 * `isActive` is seeded from Entra's `accountEnabled` at CREATE time only; an
 * EXISTING row's `isActive` (a TicketApp-local decision) is never touched by
 * sync, mirroring how `avatarSource`/`globalRoleSource` already protect
 * their own fields from being silently overwritten.
 *
 * Company/Department placement (`companyId`/`departmentId`) is resolved via
 * lib/services/organization-company-department-resolver.ts — one Company
 * root per normalized Entra `companyName`, a Department attached directly to
 * that Company (never a fabricated BusinessUnit) per normalized
 * `department`. This is ALWAYS re-resolved and overwritten on every sync,
 * for both a brand-new and an already-existing user, exactly like
 * `jobTitle`/`employeeId` above already are — Microsoft is the source of
 * truth for a Microsoft-linked user's organizational placement, so a user
 * who moved department/company in Entra is correctly moved to the new node
 * here too. This never touches DepartmentMembership/MicrosoftDepartmentMapping
 * (the permission-bearing tables — see lib/services/microsoft-mapping-service.ts) or
 * `role`/`globalRoleSource` (untouched, see the module header) — purely the
 * plain organizational-placement FKs, same category as jobTitle.
 */
async function upsertOneDirectoryUser(
  user: GraphDirectoryUser,
  rawEmail: string,
  placementCache: OrganizationResolutionCache
): Promise<DirectoryUserSyncResult> {
  const email = normalizeEmail(rawEmail);
  const department = user.department ?? null;
  const jobTitle = user.jobTitle ?? null;

  try {
    const placement = await resolveOrganizationPlacement(placementCache, user.companyName, user.department);

    let existing = await prisma.user.findUnique({ where: { microsoftUserId: user.id }, select: { id: true, name: true, microsoftUserId: true } });
    let action: DirectoryUserSyncAction = "updated";

    if (!existing) {
      const byEmail = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, microsoftUserId: true } });
      if (byEmail) {
        if (byEmail.microsoftUserId && byEmail.microsoftUserId !== user.id) {
          console.warn("[organization-directory-sync] user sync skipped", {
            microsoftUserId: user.id,
            email,
            action: "skipped",
            reason: "email_linked_to_different_microsoft_user",
          });
          return { action: "skipped", dbUserId: null, name: null, department, jobTitle, companyName: placement.companyName, resolvedDepartmentId: null, skipReason: "email_linked_to_different_microsoft_user" };
        }
        existing = byEmail;
        action = "linked";
      }
    }

    // departmentId is deliberately NOT written here anymore — it's a mirror
    // of the active PRIMARY DepartmentMembership, written only by
    // setPrimaryDepartmentMembership (called from the membership-resolution
    // loop below, once dbUserId is known) — see the canonical-membership
    // architecture. companyId has no membership-table equivalent and stays
    // a direct write, unrelated to this.
    const commonFields = {
      name: user.displayName ?? undefined,
      givenName: user.givenName ?? undefined,
      surname: user.surname ?? undefined,
      jobTitle: user.jobTitle ?? undefined,
      employeeId: user.employeeId ?? undefined,
      employeeType: user.employeeType ?? undefined,
      entraAccountEnabled: user.accountEnabled ?? undefined,
      entraUserType: user.userType ?? undefined,
      organizationSyncedAt: new Date(),
      companyId: placement.companyId,
    };

    if (existing) {
      // microsoftUserId is written unconditionally here (a no-op when action
      // is "updated" — it already matched; the actual backfill when action
      // is "linked").
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: { ...commonFields, microsoftUserId: user.id },
        select: { id: true, name: true },
      });
      console.log("[organization-directory-sync] user synced", { microsoftUserId: user.id, email, action, company: placement.companyName, department: placement.departmentName });
      return { action, dbUserId: updated.id, name: updated.name, department, jobTitle, companyName: placement.companyName, resolvedDepartmentId: placement.departmentId };
    }

    const created = await prisma.user.create({
      data: {
        email,
        name: user.displayName ?? null,
        givenName: user.givenName ?? null,
        surname: user.surname ?? null,
        microsoftUserId: user.id,
        authProvider: AuthProvider.MICROSOFT,
        isActive: user.accountEnabled ?? true,
        jobTitle: user.jobTitle ?? null,
        employeeId: user.employeeId ?? null,
        employeeType: user.employeeType ?? null,
        entraAccountEnabled: user.accountEnabled ?? null,
        entraUserType: user.userType ?? null,
        organizationSyncedAt: new Date(),
        companyId: placement.companyId,
      },
      select: { id: true, name: true },
    });
    console.log("[organization-directory-sync] user synced", { microsoftUserId: user.id, email, action: "created", company: placement.companyName, department: placement.departmentName });
    return { action: "created", dbUserId: created.id, name: created.name, department, jobTitle, companyName: placement.companyName, resolvedDepartmentId: placement.departmentId };
  } catch (err) {
    // Isolated to THIS user only (see the function header) — never runs
    // inside a transaction shared with any other user's writes, so this can
    // never cascade into 25P02 failures for the rest of the batch. Still a
    // real, unexpected failure (e.g. a genuine race, a transient DB error) —
    // counted and logged, never silently dropped.
    const reason = err instanceof Error ? err.message : String(err);
    console.warn("[organization-directory-sync] user sync failed", { microsoftUserId: user.id, email, action: "skipped", reason });
    return { action: "skipped", dbUserId: null, name: null, department, jobTitle, companyName: null, resolvedDepartmentId: null, skipReason: reason };
  }
}

/**
 * Sequentially upserts a chunk of already-validated users — sequential
 * (never Promise.all) to keep DB connection usage predictable during a
 * potentially large tenant scan, matching this service's existing
 * department-membership-resolution loop below. See BATCH_SIZE's comment and
 * upsertOneDirectoryUser's header for why this is no longer wrapped in a
 * shared transaction.
 */
async function upsertDirectoryUserBatch(
  validated: Array<{ user: GraphDirectoryUser; email: string }>,
  placementCache: OrganizationResolutionCache
): Promise<DirectoryBatchSyncCounts> {
  const counts: DirectoryBatchSyncCounts = { updated: 0, created: 0, skipped: 0, errors: 0, syncedForMembership: [] };

  for (const { user, email } of validated) {
    const result = await upsertOneDirectoryUser(user, email, placementCache);
    if (result.action === "created") counts.created++;
    else if (result.action === "updated" || result.action === "linked") counts.updated++;
    else counts.errors++; // identity-resolution/write failure — a real problem to investigate, distinct from the pre-batch validation `skipped` counter (guest/service accounts, missing email)

    if (result.dbUserId) {
      counts.syncedForMembership.push({
        dbUserId: result.dbUserId,
        microsoftUserId: user.id,
        email: normalizeEmail(email),
        name: result.name,
        department: result.department,
        jobTitle: result.jobTitle,
        resolvedDepartmentId: result.resolvedDepartmentId,
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
  /** Persisted DB contract (OrganizationSyncRun) — never renamed/removed; usersUpdated already includes newly-created users, unchanged since before FIND-003. */
  usersScanned: number;
  usersUpdated: number;
  usersSkipped: number;
  errorCount: number;
  rawUsers: DirectoryRawUserRecord[];
  /**
   * Additive, NOT persisted to OrganizationSyncRun (which has no matching
   * columns — adding them would need a migration this feature doesn't
   * need) — a more granular in-memory/log breakdown for FIND-003 visibility.
   * usersSkippedDomain + usersSkippedGuest + (missing_id/missing_email_and_upn,
   * uncommon) sum to `usersSkipped` above.
   */
  usersEligible?: number;
  usersSkippedDomain?: number;
  usersSkippedGuest?: number;
  usersCreatedCount?: number;
  usersUpdatedCount?: number;
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
  let usersSkippedDomain = 0;
  let usersSkippedGuest = 0;
  let errorCount = 0;
  const syncedForMembership: DirectoryBatchSyncCounts["syncedForMembership"] = [];

  const validatedUsers: Array<{ user: GraphDirectoryUser; email: string }> = [];
  const excludedMicrosoftUserIds = new Set<string>();
  for (const raw of fetchResult.users) {
    const result = validateDirectoryUser(raw);
    if (!result.valid) {
      usersSkipped++;
      if (result.reason === "domain_not_eligible") usersSkippedDomain++;
      else if (result.reason === "guest_or_service_account") usersSkippedGuest++;
      if (raw.id) excludedMicrosoftUserIds.add(raw.id);
      continue;
    }
    validatedUsers.push({ user: result.user, email: result.email });
  }
  const usersEligible = validatedUsers.length;

  // One resolution cache for the WHOLE run — every user's Company/Department
  // lookup shares it, so scanning a tenant with thousands of users against a
  // handful of real companies/departments costs O(distinct companies +
  // distinct departments) find-or-create round trips, not O(users). See
  // lib/services/organization-company-department-resolver.ts.
  const placementCache = createOrganizationResolutionCache();

  // No shared transaction across a batch (see BATCH_SIZE's comment and
  // upsertOneDirectoryUser's header for the production incident this fixed)
  // — upsertDirectoryUserBatch/upsertOneDirectoryUser never throw, every
  // per-user outcome (including a failure) is already captured in `counts`,
  // so no try/catch is needed here.
  for (let i = 0; i < validatedUsers.length; i += BATCH_SIZE) {
    const batch = validatedUsers.slice(i, i + BATCH_SIZE);
    const counts = await upsertDirectoryUserBatch(batch, placementCache);
    usersUpdated += counts.updated;
    usersCreated += counts.created;
    errorCount += counts.errors;
    syncedForMembership.push(...counts.syncedForMembership);
  }

  // Department-membership resolution, one user at a time, sequentially (not
  // Promise.all) to keep DB load predictable during a potentially large
  // batch — each user's primary + secondary resolution runs as its own
  // bounded operation(s), never a single giant shared transaction (see this
  // file's own header comment on the production incident that rule exists
  // to prevent).
  //
  // Step 1 — PRIMARY: the multi-company Company/Department placement
  // resolved during the upsert above (organization-company-department-resolver.ts,
  // `synced.resolvedDepartmentId`) becomes this user's primary organizational
  // department via setPrimaryDepartmentMembership — the single canonical
  // write path for User.departmentId + the active primary DepartmentMembership
  // together (see the User/Department/Member canonical-membership
  // architecture). This is what used to write User.departmentId directly in
  // upsertOneDirectoryUser above WITHOUT ever creating a matching
  // membership — the real bug this closes. DepartmentRole.REQUESTER matches
  // the existing auto-create default elsewhere in this codebase
  // (microsoft-department-autocreate-service.ts) — Microsoft sync never
  // does role mapping (see this file's own role-protection rules below),
  // this is just the least-privileged starting DepartmentRole for a
  // membership that exists purely to reflect organizational placement.
  // deactivateObsoleteMicrosoftPrimary: true — an organizational move
  // detected by Microsoft sync must not leave a stale Microsoft-granted
  // primary department access behind (a MANUAL primary is never touched
  // regardless — setPrimaryDepartmentMembership's own protection).
  //
  // Step 2 — SECONDARY: reuses the exact same MicrosoftDepartmentMapping-
  // based functions the login path calls (lib/services/microsoft-mapping-service.ts,
  // lib/services/department-membership-service.ts) for any OTHER explicit
  // admin-configured mapping (group/app-role/job-title) — completely
  // independent of the primary placement above, and never touches MANUAL
  // memberships (syncDepartmentMemberships's own existing protection).
  for (const synced of syncedForMembership) {
    if (synced.resolvedDepartmentId) {
      try {
        await setPrimaryDepartmentMembership(synced.dbUserId, synced.resolvedDepartmentId, MembershipSource.MICROSOFT_DEPARTMENT, {
          role: DepartmentRole.REQUESTER,
          deactivateObsoleteMicrosoftPrimary: true,
        });
      } catch (err) {
        errorCount++;
        console.warn("[organization-directory-sync] Failed to set primary department membership", {
          dbUserId: synced.dbUserId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
    usersEligible,
    usersSkippedDomain,
    usersSkippedGuest,
    usersCreatedCount: usersCreated,
    usersUpdatedCount: usersUpdated,
  };
}
