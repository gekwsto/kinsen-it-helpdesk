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
 *      - Endpoint: GET /users?$select=id,department,jobTitle,userType,mail,
 *        userPrincipalName&$top=999, paged
 *      - Token: application (client-credentials), via getAppOnlyGraphAccessToken()
 *      - Permission: Directory.Read.All (Application, admin consent required)
 *      - Reads every user in the tenant, but only COLLECTS department/
 *        jobTitle values from users who pass the same shared
 *        organization-sync eligibility rule as the rest of the app (see
 *        organization-directory-eligibility-service.ts, FIND-003 in
 *        docs/roadmap-handoff-register.md) — a guest, service account, or
 *        non-`@<ALLOWED_EMAIL_DOMAIN>` identity's department/job title never
 *        pollutes the admin mapping dropdowns. This is a real fix, not
 *        cosmetic: before this, ANY tenant user's raw text (including
 *        another company's job titles, if this tenant is ever multi-domain)
 *        could show up as a mapping option. Purely to populate the admin
 *        mapping dropdowns (department/job title) and, for job titles only,
 *        the domain-scoped MicrosoftDirectoryJobTitleValue.userCount used by
 *        the Job Titles admin panel. Never called from the login path, never
 *        called on page render or modal open — only from the admin-triggered
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
import { getAppOnlyGraphAccessToken, GraphConfigurationError } from "@/lib/microsoft-graph";
import { getOrganizationDirectoryEligibility, extractEmailDomain } from "@/lib/services/organization-directory-eligibility-service";
import { ALLOWED_ORGANIZATION_EMAIL_DOMAINS } from "@/lib/allowed-email-domains";

const GRAPH_USERS_PAGE_URL =
  "https://graph.microsoft.com/v1.0/users?$select=id,department,jobTitle,userType,mail,userPrincipalName&$top=999";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 200; // guards against a runaway @odata.nextLink loop; ~200k users at $top=999

export type DirectoryFetchFailureReason =
  | "unauthorized"
  | "no_permission"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response"
  // Distinct from network_error: GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET
  // are missing or fail format validation (see
  // readAndValidateGraphCredentials in lib/microsoft-graph.ts) — no
  // network request was even attempted. A caller/admin UI should point at
  // fixing configuration for this reason, not "check your connection".
  | "configuration_error";

/** One distinct, eligible-domain job title value plus how many eligible users currently have it — the basis of MicrosoftDirectoryJobTitleValue.userCount. */
export interface JobTitleCount {
  /** First-seen raw casing/spacing (trimmed only) — used as the stored display value. */
  value: string;
  /** trim + collapse-internal-whitespace + lowercase — the dedup/match key. */
  normalizedValue: string;
  count: number;
}

export interface DirectoryFetchValues {
  departments: string[];
  jobTitles: string[];
  /**
   * Job title counts, bucketed by the domain the OBSERVING eligible users
   * actually belong to (never a single assumed domain) — a title seen only
   * among saracakis.gr users must never be tagged/counted under kinsen.gr,
   * and vice versa. Keyed by domain string (one of
   * ALLOWED_ORGANIZATION_EMAIL_DOMAINS, see lib/allowed-email-domains.ts).
   * The same title text can legitimately appear under more than one
   * domain's bucket — each domain's MicrosoftDirectoryJobTitleValue rows
   * are a fully independent, separately keyed set (domain, normalizedValue).
   */
  jobTitleCountsByDomain: Record<string, JobTitleCount[]>;
  /**
   * Distinct email domains seen on Member-type users that did NOT match any
   * configured allowed domain — pure visibility for an admin ("we also saw
   * these domains in the tenant but they aren't enabled"), never used to
   * gate or process anything. Empty when every Member account in the
   * tenant is on a configured domain.
   */
  otherDomainsObserved: string[];
}

export type DirectoryFetchResult =
  | { ok: true; values: DirectoryFetchValues }
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

interface GraphUsersPage {
  value: Array<{
    department?: string | null;
    jobTitle?: string | null;
    userType?: string | null;
    mail?: string | null;
    userPrincipalName?: string | null;
  }>;
  "@odata.nextLink"?: string;
}

function isGraphUsersPage(data: unknown): data is GraphUsersPage {
  return typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).value);
}

/**
 * trim + collapse-internal-whitespace + lowercase — the ONE normalization
 * used everywhere a Job Title value needs a stable dedup/match key (this
 * file's discovery/sync, microsoft-job-title-directory-service.ts's admin
 * listing, and matched consistently against MicrosoftDepartmentMapping's
 * existing case-insensitive PROFILE_JOB_TITLE comparison in
 * microsoft-mapping-service.ts's findActiveMappingsForClaims). Exported so
 * nothing re-implements a slightly different normalization.
 */
export function normalizeJobTitleValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Pages through the tenant's users in ONE combined scan, collecting
 * distinct, trimmed, non-empty `department` AND `jobTitle` values —
 * FROM ELIGIBLE (`@<ALLOWED_EMAIL_DOMAIN>`, userType=Member) USERS ONLY, per
 * this file's header comment. Never throws — every failure is a typed
 * result.
 */
export async function fetchAllGraphUserDirectoryValues(): Promise<DirectoryFetchResult> {
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch (err) {
    if (err instanceof GraphConfigurationError) return { ok: false, reason: "configuration_error" };
    return { ok: false, reason: "network_error" };
  }

  const departments = new Set<string>();
  const jobTitles = new Set<string>();
  // domain -> normalizedValue -> {value: first-seen raw casing, count}
  const jobTitleCountsByDomain = new Map<string, Map<string, JobTitleCount>>();
  const otherDomainsObserved = new Set<string>();
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
      const eligibility = getOrganizationDirectoryEligibility({
        userType: user.userType,
        mail: user.mail,
        userPrincipalName: user.userPrincipalName,
      });

      if (!eligibility.eligible) {
        // Only report OTHER domains for a real Member account that simply
        // isn't on an allowed domain — a Guest/service account (reason
        // "not_member") tells us nothing useful about tenant domains.
        if (eligibility.reason === "no_matching_domain") {
          const candidate = user.mail?.trim() || user.userPrincipalName?.trim() || "";
          const domain = candidate ? extractEmailDomain(candidate) : null;
          if (domain) otherDomainsObserved.add(domain);
        }
        continue;
      }

      // .trim() only strips leading/trailing whitespace — never alters
      // internal characters/casing, so stored values still match what
      // Graph will send at login time.
      const dept = typeof user.department === "string" ? user.department.trim() : "";
      if (dept) departments.add(dept);

      const title = typeof user.jobTitle === "string" ? user.jobTitle.trim() : "";
      if (title) {
        jobTitles.add(title);
        // This user's OWN matched domain (never a single assumed one) — a
        // title observed on a saracakis.gr user is counted/tagged under
        // saracakis.gr, a title observed on a kinsen.gr user under
        // kinsen.gr, even within the same tenant scan.
        const userDomain = extractEmailDomain(eligibility.matchedEmail);
        if (userDomain) {
          const normalized = normalizeJobTitleValue(title);
          let domainBucket = jobTitleCountsByDomain.get(userDomain);
          if (!domainBucket) {
            domainBucket = new Map<string, JobTitleCount>();
            jobTitleCountsByDomain.set(userDomain, domainBucket);
          }
          const existing = domainBucket.get(normalized);
          if (existing) existing.count += 1;
          else domainBucket.set(normalized, { value: title, normalizedValue: normalized, count: 1 });
        }
      }
    }

    url = data["@odata.nextLink"];
  }

  const jobTitleCountsByDomainResult: Record<string, JobTitleCount[]> = {};
  for (const [domain, counts] of jobTitleCountsByDomain) {
    jobTitleCountsByDomainResult[domain] = Array.from(counts.values()).sort((a, b) => a.value.localeCompare(b.value));
  }

  return {
    ok: true,
    values: {
      departments: Array.from(departments).sort((a, b) => a.localeCompare(b)),
      jobTitles: Array.from(jobTitles).sort((a, b) => a.localeCompare(b)),
      jobTitleCountsByDomain: jobTitleCountsByDomainResult,
      otherDomainsObserved: Array.from(otherDomainsObserved).sort((a, b) => a.localeCompare(b)),
    },
  };
}

// Structural shape for the simple, `value`-only-unique directory-value
// cache tables. Only MicrosoftDirectoryDepartmentValue uses this generic
// path now — MicrosoftDirectoryJobTitleValue outgrew it (domain/
// normalizedValue/userCount, see the model's schema comment) and has its
// own dedicated syncJobTitleDirectoryTable below.
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

/**
 * Job-title-table-specific counterpart to syncDirectoryValueTable above —
 * diverges from the shared generic helper because this table alone carries
 * `domain`/`normalizedValue`/`userCount` (see the model's own schema
 * comment). Upserts by the (domain, normalizedValue) compound key — NEVER
 * by `value` — so two different casings of the same title never create two
 * rows, and a legacy Operation-A-created row with a different casing never
 * collides with the compound unique index. `value` (display casing) is only
 * ever set on CREATE — an update never rewrites it, so the cache's display
 * casing stays stable across syncs even if a later scan sees a different
 * casing from a different user.
 */
async function syncJobTitleDirectoryTable(domain: string, seen: JobTitleCount[]): Promise<TableSyncSummary> {
  const existing = await prisma.microsoftDirectoryJobTitleValue.findMany({
    where: { domain },
    select: { normalizedValue: true, isActive: true },
  });
  const existingByNormalized = new Map(existing.map((row) => [row.normalizedValue, row.isActive]));

  let added = 0;
  let updated = 0;
  for (const { value, normalizedValue, count } of seen) {
    const priorIsActive = existingByNormalized.get(normalizedValue);
    await prisma.microsoftDirectoryJobTitleValue.upsert({
      where: { domain_normalizedValue: { domain, normalizedValue } },
      create: { value, domain, normalizedValue, userCount: count, firstSeenAt: new Date(), lastSeenAt: new Date(), isActive: true },
      update: { userCount: count, lastSeenAt: new Date(), isActive: true },
    });
    if (priorIsActive === undefined) added++;
    else if (!priorIsActive) updated++;
  }

  const seenNormalized = new Set(seen.map((s) => s.normalizedValue));
  const staleNormalized = existing.filter((row) => row.isActive && !seenNormalized.has(row.normalizedValue)).map((row) => row.normalizedValue);
  if (staleNormalized.length > 0) {
    await prisma.microsoftDirectoryJobTitleValue.updateMany({
      where: { domain, normalizedValue: { in: staleNormalized } },
      data: { isActive: false, userCount: 0 },
    });
  }

  return { added, updated, staled: staleNormalized.length };
}

export interface DirectorySyncSummary {
  discoveredDepartments: number;
  addedDepartments: number;
  updatedDepartments: number;
  staledDepartments: number;
  /** Sum across every configured allowed domain — see perDomainJobTitles for the per-domain breakdown. */
  discoveredJobTitles: number;
  addedJobTitles: number;
  updatedJobTitles: number;
  staledJobTitles: number;
  /** One entry per configured allowed domain (lib/allowed-email-domains.ts) — every domain is synced (and stale-marked) every run, even one with zero eligible users this time, exactly like the single-domain behavior this replaces always did for its one domain. */
  perDomainJobTitles: Array<{ domain: string; discovered: number; added: number; updated: number; staled: number }>;
  /** Non-allowed-domain Member accounts observed this run — visibility only, see DirectoryFetchValues.otherDomainsObserved. */
  otherDomainsObserved: string[];
}

export type DirectorySyncResult =
  | ({ ok: true } & DirectorySyncSummary)
  | { ok: false; reason: DirectoryFetchFailureReason; status?: number };

/**
 * Admin-triggered only. Fetches the current distinct department + jobTitle
 * values from Graph in one combined scan (eligible Member users on any
 * configured allowed domain only, see this file's header) and upserts both
 * cache tables — job titles once per configured allowed domain, each
 * domain's own MicrosoftDirectoryJobTitleValue rows kept fully independent
 * (see DirectoryFetchValues.jobTitleCountsByDomain's doc comment).
 */
export async function syncMicrosoftDirectoryValues(): Promise<DirectorySyncResult> {
  const result = await fetchAllGraphUserDirectoryValues();
  if (!result.ok) {
    console.warn("[microsoft-directory] Directory sync failed", { reason: result.reason, status: result.status });
    return result;
  }

  const seenDepartments = new Set(result.values.departments);

  const deptSummary = await syncDirectoryValueTable(prisma.microsoftDirectoryDepartmentValue, seenDepartments);

  // Every configured allowed domain is synced — not just domains that
  // happened to have an eligible user with a job title THIS run — so a
  // domain that temporarily has zero eligible users still gets its stale
  // rows correctly marked inactive (self-healing), matching exactly what
  // the single-domain implementation always did for its one domain.
  const perDomainJobTitles: DirectorySyncSummary["perDomainJobTitles"] = [];
  let discoveredJobTitles = 0;
  let addedJobTitles = 0;
  let updatedJobTitles = 0;
  let staledJobTitles = 0;
  for (const domain of ALLOWED_ORGANIZATION_EMAIL_DOMAINS) {
    const counts = result.values.jobTitleCountsByDomain[domain] ?? [];
    const summary = await syncJobTitleDirectoryTable(domain, counts);
    perDomainJobTitles.push({ domain, discovered: counts.length, ...summary });
    discoveredJobTitles += counts.length;
    addedJobTitles += summary.added;
    updatedJobTitles += summary.updated;
    staledJobTitles += summary.staled;
  }
  const titleSummary = { added: addedJobTitles, updated: updatedJobTitles, staled: staledJobTitles };

  console.log("[microsoft-directory] Directory sync completed", {
    discoveredDepartments: seenDepartments.size,
    ...deptSummary,
    discoveredJobTitles,
    ...titleSummary,
    perDomainJobTitles,
    otherDomainsObserved: result.values.otherDomainsObserved,
  });

  return {
    ok: true,
    discoveredDepartments: seenDepartments.size,
    addedDepartments: deptSummary.added,
    updatedDepartments: deptSummary.updated,
    staledDepartments: deptSummary.staled,
    discoveredJobTitles,
    addedJobTitles,
    updatedJobTitles,
    staledJobTitles,
    perDomainJobTitles,
    otherDomainsObserved: result.values.otherDomainsObserved,
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
 * an empty value; trims before storing/comparing. Never throws — a cache
 * fill must never break a real Microsoft sign-in (see the try/catch in the
 * jobTitle branch below, added specifically for this reason).
 *
 * `domain` is REQUIRED for `kind: "jobTitle"` (ignored for "department",
 * which isn't domain-scoped) — this function only ever runs for an
 * already-authenticated Microsoft sign-in, which lib/auth.ts already gated
 * to an allowed organization domain, but with more than one allowed domain
 * configured there is no longer a single correct constant to assume; the
 * caller (microsoft-department-sync-service.ts) must pass THIS user's own
 * matched domain. A missing domain for a job title is a safe no-op (never
 * guesses) rather than mistagging it under the wrong domain.
 */
export async function upsertDiscoveredMicrosoftDirectoryValue(
  kind: "department" | "jobTitle",
  value: string,
  domain?: string | null
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) return;

  if (kind === "department") {
    await prisma.microsoftDirectoryDepartmentValue.upsert({
      where: { value: trimmed },
      create: { value: trimmed, firstSeenAt: new Date(), lastSeenAt: new Date(), isActive: true },
      update: { lastSeenAt: new Date(), isActive: true },
    });
    return;
  }

  if (!domain) return;

  // Job title: upsert by the (domain, normalizedValue) compound key, never
  // by `value` — domain is this specific user's own matched allowed
  // domain (see this function's doc comment), never a single assumed
  // constant. userCount is deliberately left untouched (this call only
  // ever observes ONE user, so it cannot know the real tenant-wide count)
  // — only the admin-triggered syncJobTitleDirectoryTable (a full,
  // eligibility-filtered tenant scan) is authoritative for userCount.
  try {
    const normalizedValue = normalizeJobTitleValue(trimmed);
    const existing = await prisma.microsoftDirectoryJobTitleValue.findUnique({
      where: { domain_normalizedValue: { domain, normalizedValue } },
      select: { id: true },
    });
    if (existing) {
      await prisma.microsoftDirectoryJobTitleValue.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date(), isActive: true },
      });
    } else {
      await prisma.microsoftDirectoryJobTitleValue.create({
        data: { value: trimmed, domain, normalizedValue, firstSeenAt: new Date(), lastSeenAt: new Date(), isActive: true },
      });
    }
  } catch (err) {
    console.warn("[microsoft-directory] Opportunistic job title cache fill skipped", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
