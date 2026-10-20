/**
 * Client for the external HR directory API (Azure Data API Builder,
 * `sql-api.saracakis.gr`) — the organization-data source
 * lib/services/hr-directory-sync-service.ts and the per-login placement in
 * lib/services/microsoft-department-sync-service.ts both read from, replacing
 * Microsoft Graph as the source of company/department/manager-chain data.
 * Microsoft Entra ID SSO login itself (lib/auth.ts/lib/auth.config.ts) does
 * not import this module at all and is completely unaffected by it.
 *
 * Auth: app-only (client-credentials) Azure AD token, same mechanics as
 * lib/microsoft-graph.ts's getAppOnlyGraphAccessToken — but a SEPARATE,
 * independent credential namespace (HR_API_ prefixed, not GRAPH_ or
 * AUTH_MICROSOFT_ENTRA_ID_ prefixed), even if the real deployment happens to
 * point them at the same tenant — matching this codebase's existing
 * convention of one credential namespace per purpose, not per provider (see
 * lib/microsoft-graph.ts's own header comment on those two namespaces).
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

/** Distinct from a generic Error, same reason as GraphConfigurationError (lib/microsoft-graph.ts) — lets callers classify "not configured at all" apart from "reachable but failed." */
export class HrApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HrApiConfigurationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

interface HrApiCredentials {
  baseUrl: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** Reads + trims + validates HR_API_BASE_URL/HR_API_TENANT_ID/HR_API_CLIENT_ID/HR_API_CLIENT_SECRET/HR_API_SCOPE — same shape of guards as lib/microsoft-graph.ts's readAndValidateGraphCredentials, never logs the secret itself. */
function readAndValidateHrApiCredentials(): HrApiCredentials {
  const rawBaseUrl = process.env.HR_API_BASE_URL;
  const rawTenantId = process.env.HR_API_TENANT_ID;
  const rawClientId = process.env.HR_API_CLIENT_ID;
  const rawClientSecret = process.env.HR_API_CLIENT_SECRET;
  const rawScope = process.env.HR_API_SCOPE;

  if (!rawBaseUrl?.trim()) throw new HrApiConfigurationError("HR directory API is not configured: HR_API_BASE_URL is empty or unset.");
  if (!rawTenantId?.trim()) throw new HrApiConfigurationError("HR directory API is not configured: HR_API_TENANT_ID is empty or unset.");
  if (!rawClientId?.trim()) throw new HrApiConfigurationError("HR directory API is not configured: HR_API_CLIENT_ID is empty or unset.");
  if (!rawClientSecret?.trim()) throw new HrApiConfigurationError("HR directory API is not configured: HR_API_CLIENT_SECRET is empty or unset.");
  if (!rawScope?.trim()) throw new HrApiConfigurationError("HR directory API is not configured: HR_API_SCOPE is empty or unset.");

  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
  const tenantId = rawTenantId.trim();
  const clientId = rawClientId.trim();
  const clientSecret = rawClientSecret.trim();
  const scope = rawScope.trim();

  for (const [label, value] of [
    ["HR_API_BASE_URL", baseUrl],
    ["HR_API_TENANT_ID", tenantId],
    ["HR_API_CLIENT_ID", clientId],
    ["HR_API_CLIENT_SECRET", clientSecret],
    ["HR_API_SCOPE", scope],
  ] as const) {
    if (isObviousPlaceholder(value)) {
      throw new HrApiConfigurationError(`${label} looks like a placeholder value ("${value}"), not a real configured value.`);
    }
  }

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new HrApiConfigurationError(`HR_API_BASE_URL ("${baseUrl}") must be a full URL, e.g. "https://sql-api.saracakis.gr".`);
  }
  if (/^https?:\/\//i.test(tenantId) || /\s/.test(tenantId) || (!UUID_RE.test(tenantId) && !DOMAIN_RE.test(tenantId))) {
    throw new HrApiConfigurationError(`HR_API_TENANT_ID ("${tenantId}") is not a valid tenant UUID or domain format.`);
  }
  if (!UUID_RE.test(clientId)) {
    throw new HrApiConfigurationError(`HR_API_CLIENT_ID ("${clientId}") is not a valid GUID — Azure AD application (client) IDs are always UUIDs.`);
  }

  return { baseUrl, tenantId, clientId, clientSecret, scope };
}

/** Same non-JSON-body safety net as lib/microsoft-graph.ts's readJsonResponse — never an unconditional response.json(). */
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
  throw new Error(
    `Expected a JSON response but got ${looksLikeJson ? "unparseable content claiming to be JSON" : "a non-JSON response"} ` +
      `(status=${response.status} ${response.statusText}, content-type="${contentType}", requestedUrl=${requestedUrl}, ` +
      `finalUrl=${response.url}, redirected=${response.redirected}). Body preview: "${preview}"`
  );
}

async function getAccessToken(): Promise<string> {
  const { tenantId, clientId, clientSecret, scope } = readAndValidateHrApiCredentials();
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") ?? "(none)";
    if (contentType.toLowerCase().includes("application/json")) {
      let detail = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string; error_description?: string; correlation_id?: string };
        if (parsed.error) {
          detail = `${parsed.error}: ${(parsed.error_description ?? "").split("\n")[0]}${parsed.correlation_id ? ` (correlation_id: ${parsed.correlation_id})` : ""}`;
        }
      } catch {
        // fall through to raw body text
      }
      throw new Error(`Failed to get HR API access token: ${response.status} ${response.statusText} — ${detail}`);
    }
    const preview = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      `Failed to get HR API access token: non-JSON response (status=${response.status} ${response.statusText}, ` +
        `content-type="${contentType}", requestedUrl=${tokenUrl}). Body preview: "${preview}"`
    );
  }

  const data = await readJsonResponse<{ access_token: string }>(response, tokenUrl);
  return data.access_token;
}

/** Exported for callers that just need the raw token + base URL (none today — kept symmetrical with getAppOnlyGraphAccessToken's own export). */
export async function getAppOnlyHrApiAccessToken(): Promise<string> {
  return getAccessToken();
}

export interface HrUsersAndManagersRow {
  Source: string | null;
  UniqueEmployeeIdUsername: string | null;
  sAMAccountName: string | null;
  Username: string | null;
  HREmployeeId: number | null;
  EmployeeNumber: string | null;
  DisplayName: string | null;
  Mail: string | null;
  Title: string | null;
  HrDepartmentId: number | null;
  Department: string | null;
  CompanyId: number | null;
  Company: string | null;
  Active: boolean | null;
  ObjectId: string | null;
  managerAMAccountName: string | null;
  ManagerDisplayName: string | null;
  managerMail: string | null;
  manager2AMAccountName: string | null;
  Manager2DisplayName: string | null;
  manager2Mail: string | null;
  manager3AMAccountName: string | null;
  Manager3DisplayName: string | null;
  manager3Mail: string | null;
}

const ENTITY_PATH = "/api/UsersAndManagers";
const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_PAGES = 500; // guards a runaway pagination loop — same defensive cap philosophy as organization-directory-sync-service.ts's MAX_PAGES

export type HrApiFailureReason =
  | "unauthorized"
  | "no_permission"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response"
  | "configuration_error";

export type FetchHrUsersResult =
  | { ok: true; rows: HrUsersAndManagersRow[] }
  | { ok: false; reason: HrApiFailureReason; status?: number };

interface HrApiPage {
  value: HrUsersAndManagersRow[];
  // Data API Builder's REST pagination convention — a full, ready-to-call
  // URL for the next page, present only when more rows remain. Exact field
  // name unverified against a live instance (no real credentials yet — see
  // the STOP FOR REVIEW notes); `nextLink` is DAB's documented convention,
  // so this is the primary name checked, with a couple of plausible
  // fallbacks so a real response that uses a slightly different casing
  // still pages through, instead of silently truncating at page 1.
  nextLink?: string;
}

function isHrApiPage(data: unknown): data is HrApiPage {
  return typeof data === "object" && data !== null && Array.isArray((data as Record<string, unknown>).value);
}

function extractNextLink(data: Record<string, unknown>): string | undefined {
  const candidates = ["nextLink", "NextLink", "@odata.nextLink"];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

async function performGet(url: string, token: string): Promise<Response> {
  const { fetchWithGraphRetry } = await import("@/lib/microsoft-graph-retry");
  return fetchWithGraphRetry(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function classifyFailureStatus(status: number): HrApiFailureReason {
  if (status === 401) return "unauthorized";
  if (status === 403) return "no_permission";
  if (status === 429) return "rate_limited";
  return "server_error";
}

/**
 * Pages through the FULL `UsersAndManagers` result set, following every
 * `nextLink` (see HrApiPage's own doc comment on the exact field name still
 * needing live-API confirmation). Never throws — every failure is a typed
 * result, matching lib/services/organization-directory-sync-service.ts's
 * existing Graph-call convention.
 */
export async function fetchAllHrUsersAndManagers(): Promise<FetchHrUsersResult> {
  let token: string;
  let baseUrl: string;
  try {
    const creds = readAndValidateHrApiCredentials();
    baseUrl = creds.baseUrl;
    token = await getAccessToken();
  } catch (err) {
    if (err instanceof HrApiConfigurationError) return { ok: false, reason: "configuration_error" };
    return { ok: false, reason: "network_error" };
  }

  const rows: HrUsersAndManagersRow[] = [];
  let url: string | undefined = `${baseUrl}${ENTITY_PATH}?$first=${PAGE_SIZE}`;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    pages++;
    let response: Response;
    try {
      response = await performGet(url, token);
    } catch {
      return { ok: false, reason: "network_error" };
    }

    if (!response.ok) return { ok: false, reason: classifyFailureStatus(response.status), status: response.status };

    let data: unknown;
    try {
      data = await readJsonResponse(response, url);
    } catch {
      return { ok: false, reason: "malformed_response" };
    }
    if (!isHrApiPage(data)) return { ok: false, reason: "malformed_response" };

    rows.push(...data.value);
    url = extractNextLink(data as unknown as Record<string, unknown>);
  }

  return { ok: true, rows };
}

export type FetchHrUserByMailResult =
  | { ok: true; row: HrUsersAndManagersRow | null }
  | { ok: false; reason: HrApiFailureReason; status?: number };

/**
 * Single-row lookup by email — used by the per-login placement hook
 * (lib/services/microsoft-department-sync-service.ts), which already has a
 * verified email from Graph's own delegated `/me` call and queries by THAT,
 * never by a username derived from the email's local-part (the HR API's own
 * sample data shows those two are not guaranteed to match).
 */
export async function fetchHrUserByMail(mail: string): Promise<FetchHrUserByMailResult> {
  let token: string;
  let baseUrl: string;
  try {
    const creds = readAndValidateHrApiCredentials();
    baseUrl = creds.baseUrl;
    token = await getAccessToken();
  } catch (err) {
    if (err instanceof HrApiConfigurationError) return { ok: false, reason: "configuration_error" };
    return { ok: false, reason: "network_error" };
  }

  // OData string-literal escaping: a literal `'` is doubled — same rule
  // lib/microsoft-graph.ts's getMessageByInternetMessageId already applies.
  const escaped = mail.replace(/'/g, "''");
  const url = `${baseUrl}${ENTITY_PATH}?$filter=${encodeURIComponent(`Mail eq '${escaped}'`)}&$first=1`;

  let response: Response;
  try {
    response = await performGet(url, token);
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (!response.ok) return { ok: false, reason: classifyFailureStatus(response.status), status: response.status };

  let data: unknown;
  try {
    data = await readJsonResponse(response, url);
  } catch {
    return { ok: false, reason: "malformed_response" };
  }
  if (!isHrApiPage(data)) return { ok: false, reason: "malformed_response" };

  return { ok: true, row: data.value[0] ?? null };
}
