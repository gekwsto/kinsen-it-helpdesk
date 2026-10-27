/**
 * SQLGeneral Organization Sync API client — a Data API Builder/OData backend,
 * completely independent of Microsoft Graph's own API surface (it only
 * shares the same Entra TENANT, and possibly the same app registration/
 * credentials if that's the one actually granted the "Org.Read" application
 * role on this API — see readAndValidateSqlGeneralCredentials below).
 *
 * VERIFIED (per user report, production, real Entra client credentials +
 * Org.Read role — NOT independently re-run from this environment, which
 * still only has placeholder SQLGENERAL_* values):
 *   - `GET /api/UsersAndManagers` and `GET /api/Departments` both return 200
 *     with the Org.Read role.
 *   - UsersAndManagers fields: Username, Mail, HrDepartmentId, Department,
 *     CompanyId, Company, Active, managerAMAccountName,
 *     manager2AMAccountName, manager3AMAccountName (+ unspecified
 *     additional employee/manager metadata, not consumed here).
 *   - Departments fields: Id, Description, IsActive, ParentDepartmentId,
 *     Country, Company, CompanyShortname, CreationDate, UpdateTimestamp.
 *
 * STILL UNVERIFIED from this environment (no real credentials here — every
 * function below is correct-by-construction against the field names above,
 * but has never actually executed against the live API):
 *   - That `client_credentials` + the Org.Read role is obtainable via the
 *     SAME tenant login endpoint this file uses (https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token)
 *     rather than some other flow — assumed, following the same pattern
 *     lib/microsoft-graph.ts already uses successfully for a different API.
 *   - Multi-page pagination mechanics: the Postman collection documents
 *     only `$first` (page size) and the `{"value":[...]}"` envelope, never
 *     a second page. fetchAllPages below follows a `nextLink` field per
 *     Azure Data API Builder's own documented convention — NOT confirmed
 *     against a real multi-page response from this specific deployment.
 *   - Departments has no literal "name" field (`Description` is the
 *     closest fit) — UsersAndManagers' own `Department` string is the only
 *     other name-shaped signal observed. Which one is the canonical display
 *     name is a mapping assumption, not a confirmed fact — see
 *     SqlGeneralDepartmentRecord's own comment.
 *   - Whether `HrDepartmentId` (on a user row) and `Departments.Id` are
 *     genuinely the same identifier space (both are opaque per the field
 *     list given) — resolveSqlGeneralDepartmentPlacement below implements
 *     the lookup assuming they are, and reports "department_not_found"
 *     rather than silently guessing when a lookup fails.
 */

const OBVIOUS_PLACEHOLDER_PATTERNS = [
  /^dummy$/i,
  /^test$/i,
  /^changeme$/i,
  /^change[-_]me$/i,
  /^your[-_].*$/i,
  /^xxx+$/i,
  /^placeholder$/i,
  /^example$/i,
  /^tbd$/i,
  /^n\/?a$/i,
  /^<.*>$/,
  /^\{.*\}$/,
];

function isObviousPlaceholder(value: string): boolean {
  return OBVIOUS_PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/** Distinct from a generic Error so callers can tell "SQLGeneral isn't configured at all" apart from a genuine network/auth/response failure — same split lib/microsoft-graph.ts's GraphConfigurationError already makes. */
export class SqlGeneralConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGeneralConfigurationError";
  }
}

/** A genuine call failure (auth, network, non-2xx, malformed body, or pagination that couldn't be confirmed complete) — never thrown for "no match", which is a typed result instead. */
export class SqlGeneralApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGeneralApiError";
  }
}

interface SqlGeneralCredentials {
  baseUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/**
 * Reads + trims + validates SQLGENERAL_API_BASE_URL/TENANT_ID/CLIENT_ID/
 * CLIENT_SECRET/SCOPE. `CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID` may be set to
 * the SAME values as this app's existing Graph/Entra credentials (GRAPH_* or
 * AUTH_MICROSOFT_ENTRA_ID_*) if that's the app registration actually granted
 * the "Org.Read" application role on the SQLGeneral API — this file never
 * assumes or defaults to that automatically, since which registration holds
 * that grant was never confirmed to me directly; it only reads whatever is
 * explicitly set under the SQLGENERAL_* names. Throws a specific, actionable
 * configuration error the moment something is missing or an obvious
 * placeholder — never logs the secret value itself. Mirrors
 * lib/microsoft-graph.ts's readAndValidateGraphCredentials.
 */
function readAndValidateSqlGeneralCredentials(): SqlGeneralCredentials {
  const rawBaseUrl = process.env.SQLGENERAL_API_BASE_URL;
  const rawTenantId = process.env.SQLGENERAL_TENANT_ID;
  const rawClientId = process.env.SQLGENERAL_CLIENT_ID;
  const rawClientSecret = process.env.SQLGENERAL_CLIENT_SECRET;
  const rawScope = process.env.SQLGENERAL_SCOPE;

  if (!rawBaseUrl?.trim()) throw new SqlGeneralConfigurationError("SQLGeneral is not configured: SQLGENERAL_API_BASE_URL is empty or unset.");
  if (!rawTenantId?.trim()) throw new SqlGeneralConfigurationError("SQLGeneral is not configured: SQLGENERAL_TENANT_ID is empty or unset.");
  if (!rawClientId?.trim()) throw new SqlGeneralConfigurationError("SQLGeneral is not configured: SQLGENERAL_CLIENT_ID is empty or unset.");
  if (!rawClientSecret?.trim()) throw new SqlGeneralConfigurationError("SQLGeneral is not configured: SQLGENERAL_CLIENT_SECRET is empty or unset.");
  if (!rawScope?.trim()) throw new SqlGeneralConfigurationError("SQLGeneral is not configured: SQLGENERAL_SCOPE is empty or unset.");

  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
  const tenantId = rawTenantId.trim();
  const clientId = rawClientId.trim();
  const clientSecret = rawClientSecret.trim();
  const scope = rawScope.trim();

  if (isObviousPlaceholder(tenantId)) throw new SqlGeneralConfigurationError(`SQLGENERAL_TENANT_ID looks like a placeholder value ("${tenantId}"), not a real tenant ID.`);
  if (isObviousPlaceholder(clientId)) throw new SqlGeneralConfigurationError(`SQLGENERAL_CLIENT_ID looks like a placeholder value ("${clientId}"), not a real client ID.`);
  if (isObviousPlaceholder(clientSecret)) throw new SqlGeneralConfigurationError(`SQLGENERAL_CLIENT_SECRET looks like a placeholder value, not a real client secret.`);
  if (isObviousPlaceholder(scope)) throw new SqlGeneralConfigurationError(`SQLGENERAL_SCOPE looks like a placeholder value ("${scope}"), not a real scope.`);
  if (!/^https?:\/\//i.test(baseUrl)) throw new SqlGeneralConfigurationError(`SQLGENERAL_API_BASE_URL ("${baseUrl}") must be a full https:// URL.`);

  return { baseUrl, tenantId, clientId, clientSecret, scope };
}

/**
 * Deliberate manual kill-switch — gates the WORKER's claims only (see
 * processDueSqlGeneralUserSyncs in lib/services/sqlgeneral-user-sync-service.ts),
 * never the read-only Preview surface, which exists precisely so an admin
 * can see what sync WOULD do before this is ever flipped to "true".
 */
export function isSqlGeneralSyncEnabled(): boolean {
  return process.env.SQLGENERAL_SYNC_ENABLED === "true";
}

// ─── HTTP plumbing ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;
const API_ROLE = "Org.Read";
/** Hard ceiling on pages per listing call — a real multi-page response pattern has never been observed from this environment, so this is a safety bound, not a tuned value. */
const MAX_PAGES = 200;

async function readJsonResponse<T>(response: Response, requestedUrl: string): Promise<T> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "(none)";
  const looksLikeJson = contentType.toLowerCase().includes("application/json");
  if (looksLikeJson) {
    try {
      return JSON.parse(text) as T;
    } catch {
      // fall through to the sanitized error below
    }
  }
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
  throw new SqlGeneralApiError(
    `Expected a JSON response but got ${looksLikeJson ? "unparseable content claiming to be JSON" : "a non-JSON response"} ` +
      `(status=${response.status} ${response.statusText}, content-type="${contentType}", requestedUrl=${requestedUrl}). Body preview: "${preview}"`
  );
}

async function getSqlGeneralAccessToken(): Promise<string> {
  const { tenantId, clientId, clientSecret, scope } = readAndValidateSqlGeneralCredentials();
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope });

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SqlGeneralApiError(`SQLGeneral token request failed (network error): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") ?? "(none)";
    if (contentType.toLowerCase().includes("application/json")) {
      let detail = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string; error_description?: string; correlation_id?: string };
        if (parsed.error) detail = `${parsed.error}: ${(parsed.error_description ?? "").split("\n")[0]}${parsed.correlation_id ? ` (correlation_id: ${parsed.correlation_id})` : ""}`;
      } catch {
        // non-JSON-despite-header-claim — fall through with the raw (already non-secret) body text
      }
      throw new SqlGeneralApiError(`SQLGeneral token request failed: ${response.status} ${response.statusText} — ${detail}`);
    }
    const preview = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new SqlGeneralApiError(`SQLGeneral token request failed: non-JSON response (status=${response.status} ${response.statusText}). Body preview: "${preview}"`);
  }

  const data = await readJsonResponse<{ access_token: string }>(response, tokenUrl);
  return data.access_token;
}

function resolveNextUrl(baseUrl: string, nextLink: string): string {
  if (/^https?:\/\//i.test(nextLink)) return nextLink;
  return `${baseUrl}${nextLink.startsWith("/") ? "" : "/"}${nextLink}`;
}

/**
 * Fetches every page of an OData/DAB listing, bounded by MAX_PAGES, with a
 * cycle guard against a repeated nextLink. Never returns a partial result
 * silently — any page failure, malformed envelope, or pagination that can't
 * be confirmed complete is an explicit `{ ok: false }`, never a truncated
 * `{ ok: true }` with missing rows (see this file's header: nextLink
 * mechanics are the one piece of this contract never observed live).
 */
async function fetchAllPages<T>(pathAndQuery: string): Promise<{ ok: true; rows: T[] } | { ok: false; reason: string }> {
  let baseUrl: string;
  let token: string;
  try {
    baseUrl = readAndValidateSqlGeneralCredentials().baseUrl;
    token = await getSqlGeneralAccessToken();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const initialUrl = resolveNextUrl(baseUrl, pathAndQuery);

  const rows: T[] = [];
  let url: string | null = initialUrl;
  let pages = 0;
  const seenUrls = new Set<string>();

  while (url) {
    if (pages >= MAX_PAGES) return { ok: false, reason: `Pagination exceeded ${MAX_PAGES} pages without reaching the end — treating as incomplete rather than silently truncating.` };
    if (seenUrls.has(url)) return { ok: false, reason: "Pagination loop detected (a nextLink repeated) — treating as incomplete." };
    seenUrls.add(url);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", "X-MS-API-ROLE": API_ROLE, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, reason: `Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!response.ok) {
      return { ok: false, reason: `SQLGeneral API returned ${response.status} ${response.statusText} for ${url}.` };
    }

    let data: { value?: unknown; nextLink?: string };
    try {
      data = await readJsonResponse(response, url);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    if (!Array.isArray(data.value)) {
      return { ok: false, reason: `SQLGeneral API response for ${url} is missing a "value" array.` };
    }
    rows.push(...(data.value as T[]));
    pages++;

    url = typeof data.nextLink === "string" && data.nextLink.length > 0 ? resolveNextUrl(baseUrl, data.nextLink) : null;
  }

  return { ok: true, rows };
}

function escapeODataStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

// ─── UsersAndManagers ───────────────────────────────────────────────────────

/** Raw shape as returned by the API (PascalCase) — kept separate from the normalized SqlGeneralUserRecord below so the mapping step is explicit and in one place. */
interface RawSqlGeneralUser {
  Username?: unknown;
  Mail?: unknown;
  HrDepartmentId?: unknown;
  Department?: unknown;
  CompanyId?: unknown;
  Company?: unknown;
  Active?: unknown;
  managerAMAccountName?: unknown;
  manager2AMAccountName?: unknown;
  manager3AMAccountName?: unknown;
}

export interface SqlGeneralUserRecord {
  username: string;
  mail: string | null;
  /** Kept as the raw string/number the API returned — never parsed as an int, since its true type is unconfirmed; always compared via String() against Departments.Id. */
  hrDepartmentId: string | number | null;
  department: string | null;
  companyId: string | number | null;
  company: string | null;
  active: boolean | null;
  managerAMAccountName: string | null;
  manager2AMAccountName: string | null;
  manager3AMAccountName: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function strOrNum(v: unknown): string | number | null {
  return typeof v === "string" || typeof v === "number" ? v : null;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function toSqlGeneralUserRecord(raw: RawSqlGeneralUser): SqlGeneralUserRecord {
  return {
    username: typeof raw.Username === "string" ? raw.Username : "",
    mail: str(raw.Mail),
    hrDepartmentId: strOrNum(raw.HrDepartmentId),
    department: str(raw.Department),
    companyId: strOrNum(raw.CompanyId),
    company: str(raw.Company),
    active: boolOrNull(raw.Active),
    managerAMAccountName: str(raw.managerAMAccountName),
    manager2AMAccountName: str(raw.manager2AMAccountName),
    manager3AMAccountName: str(raw.manager3AMAccountName),
  };
}

export type UsernameMatchResult =
  | { outcome: "unique"; user: SqlGeneralUserRecord }
  | { outcome: "not_found" }
  | { outcome: "ambiguous"; count: number };

/**
 * Looks up exactly one SQLGeneral user by Username (matched against Graph's
 * onPremisesSamAccountName by the caller — see
 * lib/services/sqlgeneral-user-sync-service.ts). `$first=5` is enough to
 * detect ambiguity cheaply without scanning the whole table; a real
 * duplicate username in SQLGeneral is reported as "ambiguous", never
 * silently resolved by picking the first row.
 */
export async function findSqlGeneralUserByUsername(username: string): Promise<UsernameMatchResult> {
  const filter = `Username eq '${escapeODataStringLiteral(username)}'`;
  const path = `/api/UsersAndManagers?$filter=${encodeURIComponent(filter)}&$first=5`;
  const result = await fetchAllPages<RawSqlGeneralUser>(path);
  if (!result.ok) throw new SqlGeneralApiError(result.reason);
  if (result.rows.length === 0) return { outcome: "not_found" };
  if (result.rows.length > 1) return { outcome: "ambiguous", count: result.rows.length };
  return { outcome: "unique", user: toSqlGeneralUserRecord(result.rows[0]) };
}

/**
 * CompanyId's real type (numeric vs string/GUID) was never independently
 * verified (see SqlGeneralCompanyMapping's schema doc comment) — a
 * stored-as-string value that's purely digits is sent unquoted (the only
 * safe assumption for a genuinely numeric OData field); anything else is
 * sent as an escaped string literal. Either way this never guesses the
 * VALUE, only how to express an already-known value in a filter.
 */
function formatODataIdLiteral(value: string): string {
  return /^\d+$/.test(value) ? value : `'${escapeODataStringLiteral(value)}'`;
}

export type CompanyIdExistsResult = { ok: true; exists: boolean } | { ok: false; reason: string };

/**
 * Verifies a SQLGeneral CompanyId is backed by at least one real
 * UsersAndManagers row — Departments has no CompanyId field at all (see
 * this file's header), so this is the only source that can confirm one.
 * Used exclusively to gate Company mapping approval (REQUIRED #1: "never
 * approve arbitrary identifiers") — never throws; a verification failure
 * (config/network/etc.) is a typed `{ ok: false }`, which the caller must
 * treat as "cannot confirm" and therefore reject the approval, never as a
 * silent pass.
 */
export async function verifySqlGeneralCompanyIdExists(companyId: string): Promise<CompanyIdExistsResult> {
  const filter = `CompanyId eq ${formatODataIdLiteral(companyId)}`;
  const path = `/api/UsersAndManagers?$filter=${encodeURIComponent(filter)}&$first=1`;
  const result = await fetchAllPages<RawSqlGeneralUser>(path);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, exists: result.rows.length > 0 };
}

// ─── Departments ────────────────────────────────────────────────────────────

interface RawSqlGeneralDepartment {
  Id?: unknown;
  Description?: unknown;
  IsActive?: unknown;
  ParentDepartmentId?: unknown;
  Country?: unknown;
  Company?: unknown;
  CompanyShortname?: unknown;
  CreationDate?: unknown;
  UpdateTimestamp?: unknown;
}

export interface SqlGeneralDepartmentRecord {
  id: string | number;
  /**
   * The closest available "name" field — Departments has no literal `Name`
   * column in the confirmed field list; UsersAndManagers' own `Department`
   * string is the only other name-shaped signal observed, and which one is
   * the canonical display name is NOT independently confirmed. Treated as
   * the department's display name for Preview purposes only.
   */
  description: string | null;
  isActive: boolean | null;
  parentDepartmentId: string | number | null;
  country: string | null;
  company: string | null;
  companyShortname: string | null;
  creationDate: string | null;
  updateTimestamp: string | null;
}

function toSqlGeneralDepartmentRecord(raw: RawSqlGeneralDepartment): SqlGeneralDepartmentRecord {
  return {
    id: strOrNum(raw.Id) ?? "",
    description: str(raw.Description),
    isActive: boolOrNull(raw.IsActive),
    parentDepartmentId: strOrNum(raw.ParentDepartmentId),
    country: str(raw.Country),
    company: str(raw.Company),
    companyShortname: str(raw.CompanyShortname),
    creationDate: str(raw.CreationDate),
    updateTimestamp: str(raw.UpdateTimestamp),
  };
}

/**
 * Fetches the FULL Departments listing (bounded, paginated — see
 * fetchAllPages). Preview/matching always works from one complete snapshot
 * rather than resolving each user's department with a separate per-user
 * call, so a hierarchy chain can be built purely from ParentDepartmentId
 * links within one consistent set.
 */
export async function listAllSqlGeneralDepartments(): Promise<{ ok: true; departments: SqlGeneralDepartmentRecord[] } | { ok: false; reason: string }> {
  const result = await fetchAllPages<RawSqlGeneralDepartment>("/api/Departments?$first=100");
  if (!result.ok) return result;
  return { ok: true, departments: result.rows.map(toSqlGeneralDepartmentRecord) };
}

// ─── Hierarchy resolution (pure — no network) ──────────────────────────────

export interface ResolvedDepartmentPlacement {
  department: SqlGeneralDepartmentRecord;
  /** Root-to-immediate-parent order, built ONLY by following ParentDepartmentId links within the given department set — never from names or manager chains (explicit product constraint). */
  parentChain: SqlGeneralDepartmentRecord[];
  /** A ParentDepartmentId was present but not found in the given set — either the set is incomplete, or it's a dangling reference. Never silently dropped. */
  missingParent: boolean;
}

export type DepartmentPlacementResult =
  | { outcome: "resolved"; placement: ResolvedDepartmentPlacement }
  | { outcome: "department_not_found" };

/**
 * Resolves a user's HrDepartmentId against an already-fetched Departments
 * set (see listAllSqlGeneralDepartments) and walks ParentDepartmentId
 * upward to build the chain. A cycle in the external data (never trusted to
 * be acyclic) breaks the walk rather than looping forever.
 */
export function resolveSqlGeneralDepartmentPlacement(hrDepartmentId: string | number, departments: SqlGeneralDepartmentRecord[]): DepartmentPlacementResult {
  const byId = new Map(departments.map((d) => [String(d.id), d]));
  const department = byId.get(String(hrDepartmentId));
  if (!department) return { outcome: "department_not_found" };

  const parentChain: SqlGeneralDepartmentRecord[] = [];
  let missingParent = false;
  let current = department;
  const visited = new Set<string>([String(department.id)]);
  while (current.parentDepartmentId !== null) {
    const parentKey = String(current.parentDepartmentId);
    if (visited.has(parentKey)) break;
    const parent = byId.get(parentKey);
    if (!parent) {
      missingParent = true;
      break;
    }
    parentChain.unshift(parent);
    visited.add(parentKey);
    current = parent;
  }
  return { outcome: "resolved", placement: { department, parentChain, missingParent } };
}
