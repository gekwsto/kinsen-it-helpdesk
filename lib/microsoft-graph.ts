/**
 * Microsoft Graph API client for email integration.
 * Uses client credentials flow (app-only auth) to access the support mailbox.
 *
 * Required Azure App permissions (Application, not Delegated):
 *   - Mail.Read
 *   - Mail.Send
 *   - Mail.ReadWrite
 */

interface GraphMailMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  body: {
    contentType: "html" | "text";
    content: string;
  };
  from: {
    emailAddress: { name: string; address: string };
  };
  toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
  internetMessageId: string;
  conversationId: string;
  receivedDateTime: string;
  hasAttachments: boolean;
  attachments?: GraphAttachment[];
  isRead: boolean;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string; // base64 encoded
}

interface SendMailPayload {
  message: {
    subject: string;
    body: { contentType: "HTML" | "Text"; content: string };
    toRecipients: Array<{ emailAddress: { address: string; name?: string } }>;
    replyTo?: Array<{ emailAddress: { address: string; name?: string } }>;
    internetMessageHeaders?: Array<{ name: string; value: string }>;
  };
  saveToSentItems?: boolean;
}

/**
 * Exported so other app-only (client-credentials) Graph consumers — e.g.
 * lib/services/microsoft-directory-service.ts — can reuse this exact token
 * flow instead of duplicating it. Still the same app registration/tenant as
 * the mailbox polling below (GRAPH_TENANT_ID / GRAPH_CLIENT_ID /
 * GRAPH_CLIENT_SECRET); callers needing directory-wide reads (e.g.
 * `GET /users`, used by microsoft-directory-service.ts to discover company-
 * wide department values) require that same registration to additionally
 * have the `Directory.Read.All` Application permission, admin-consented in
 * Azure — see docs/microsoft-graph-directory-sync.md, which documents both
 * as the two Graph operations of one Microsoft Directory Sync module. This
 * is a *different* permission/token type than the delegated `User.Read`
 * used by the signed-in user's own `/me` call at login
 * (lib/services/microsoft-graph-profile-service.ts) — granting or missing
 * one has no effect on the other. This function itself doesn't request or
 * know about scopes beyond `.default` (whatever's been consented in Azure is
 * what's usable), so a missing permission surfaces as a 403 from Graph on
 * the actual call, not here.
 */
export async function getAppOnlyGraphAccessToken(): Promise<string> {
  return getAccessToken();
}

// ── Config preflight ────────────────────────────────────────────────────────
// Catches an obviously-wrong GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET
// BEFORE a network call is ever made, with a clear configuration error —
// instead of the previous failure mode, where a placeholder/template value
// like "<Microsoft Entra Directory Tenant ID>" got embedded straight into
// the token URL, got percent-encoded into a nonsense path segment, and
// Microsoft's login endpoint responded 200 OK with its generic interactive
// sign-in HTML page (not a JSON AADSTS error) — which then blew up as an
// opaque "Unexpected token '<'... is not valid JSON" deep inside
// response.json(), with no indication that the actual problem was upstream
// configuration, not the parsing code itself.

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
  /^<.*>$/, // e.g. "<Microsoft Entra Directory Tenant ID>" — a template/doc placeholder, never a real value
  /^\{.*\}$/, // e.g. "{tenant-id}"
];

function isObviousPlaceholder(value: string): boolean {
  return OBVIOUS_PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/**
 * Distinct from a generic Error (or a genuine network/HTTP failure) so
 * callers — e.g. fetchAllGraphUserDirectoryValues in
 * microsoft-directory-service.ts — can classify "this server isn't
 * configured for Graph at all" apart from "Graph was reachable but the
 * call failed," and report each as its own controlled, correctly-labeled
 * result instead of lumping both under a generic "network_error".
 */
export class GraphConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphConfigurationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A verified Azure AD tenant domain (e.g. "kinsen.gr", "contoso.onmicrosoft.com") is
// just as valid as a tenant UUID for this endpoint — deliberately NOT requiring UUID-only.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Reads + trims + validates GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET.
 * Throws a specific, actionable configuration error (never a generic parse
 * failure) the moment something is missing, an obvious placeholder, or in a
 * format that can never be a real tenant/client id (a full URL, a value
 * containing internal whitespace, etc.) — never logs the secret value itself.
 */
function readAndValidateGraphCredentials(): GraphCredentials {
  const rawTenantId = process.env.GRAPH_TENANT_ID;
  const rawClientId = process.env.GRAPH_CLIENT_ID;
  const rawClientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!rawTenantId?.trim()) throw new GraphConfigurationError("Microsoft Graph is not configured: GRAPH_TENANT_ID is empty or unset.");
  if (!rawClientId?.trim()) throw new GraphConfigurationError("Microsoft Graph is not configured: GRAPH_CLIENT_ID is empty or unset.");
  if (!rawClientSecret?.trim()) throw new GraphConfigurationError("Microsoft Graph is not configured: GRAPH_CLIENT_SECRET is empty or unset.");

  const tenantId = rawTenantId.trim();
  const clientId = rawClientId.trim();
  const clientSecret = rawClientSecret.trim();

  if (isObviousPlaceholder(tenantId)) {
    throw new GraphConfigurationError(`GRAPH_TENANT_ID looks like a placeholder value ("${tenantId}"), not a real Azure AD tenant ID or domain — set it to your actual tenant UUID or verified domain.`);
  }
  if (isObviousPlaceholder(clientId)) {
    throw new GraphConfigurationError(`GRAPH_CLIENT_ID looks like a placeholder value ("${clientId}"), not a real Azure AD application (client) ID.`);
  }
  if (isObviousPlaceholder(clientSecret)) {
    throw new GraphConfigurationError(`GRAPH_CLIENT_SECRET looks like a placeholder value, not a real client secret.`);
  }

  if (/^https?:\/\//i.test(tenantId)) {
    throw new GraphConfigurationError(`GRAPH_TENANT_ID looks like a full URL (e.g. an Azure Portal link), not a tenant ID or domain — it must be just the tenant UUID or verified domain, e.g. "contoso.onmicrosoft.com" or "72f988bf-...".`);
  }
  if (/\s/.test(tenantId)) {
    throw new GraphConfigurationError(`GRAPH_TENANT_ID contains whitespace ("${tenantId}") — it must be a single tenant UUID or verified domain with no spaces.`);
  }
  if (!UUID_RE.test(tenantId) && !DOMAIN_RE.test(tenantId)) {
    throw new GraphConfigurationError(`GRAPH_TENANT_ID ("${tenantId}") is not a valid tenant UUID or domain format — check it isn't an application/client ID, object ID, or display name pasted into the wrong field.`);
  }

  // Application (client) IDs in Azure AD are always GUIDs — unlike the
  // tenant field above, there's no "domain" alternative form here, so this
  // one legitimately can be validated strictly.
  if (!UUID_RE.test(clientId)) {
    throw new GraphConfigurationError(`GRAPH_CLIENT_ID ("${clientId}") is not a valid GUID — Azure AD application (client) IDs are always UUIDs; check this isn't a tenant ID, object ID, or secret value pasted into the wrong field.`);
  }

  return { tenantId, clientId, clientSecret };
}

/**
 * Reads a fetch Response body exactly once as text, then decides how to
 * interpret it — never an unconditional response.json() (which throws an
 * opaque "Unexpected token '<'..." with no context when the body turns out
 * to be HTML, e.g. a login page, a proxy/captive-portal interstitial, or any
 * other non-API response sharing the same 200 status a real JSON success
 * would have). On anything other than a genuine JSON body, throws a
 * sanitized error carrying exactly the diagnostic fields needed to tell
 * apart a bad tenant/endpoint value, a redirect, or a proxy — HTTP status,
 * content-type, the requested URL, the final (possibly redirected)
 * response.url, response.redirected, and a short, whitespace-collapsed
 * preview of the body (never the full page, never a token or secret).
 */
async function readJsonResponse<T>(response: Response, requestedUrl: string): Promise<T> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "(none)";
  const looksLikeJson = contentType.toLowerCase().includes("application/json");

  if (looksLikeJson) {
    try {
      return JSON.parse(text) as T;
    } catch {
      // Content-Type claimed JSON but the body didn't actually parse — still
      // report this as a non-JSON response rather than letting a raw
      // SyntaxError with no context surface further up the call stack.
    }
  }

  const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
  throw new Error(
    `Expected a JSON response but got ${looksLikeJson ? "unparseable content claiming to be JSON" : "a non-JSON response"} ` +
      `(status=${response.status} ${response.statusText}, content-type="${contentType}", ` +
      `requestedUrl=${requestedUrl}, finalUrl=${response.url}, redirected=${response.redirected}). ` +
      `Body preview: "${preview}"`
  );
}

async function getAccessToken(): Promise<string> {
  const { tenantId, clientId, clientSecret } = readAndValidateGraphCredentials();

  // encodeURIComponent defensively, even though a value that reaches this
  // point has already passed the format validation above (a real UUID/
  // domain has no characters that would ever need encoding) — belt and
  // braces against embedding anything unexpected into the URL path.
  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    // Azure AD's token-endpoint JSON error body (error/error_description/
    // error_codes/correlation_id) never echoes back the client secret or any
    // credential value — it's the actual diagnostic reason (e.g. AADSTS900023
    // "tenant identifier is not a valid DNS name", AADSTS7000215 "invalid
    // client secret", AADSTS700016 "application not found in directory") and
    // is safe to surface in full. When the error body ISN'T JSON (the
    // "Sign in to your account" HTML page case), readJsonResponse's own
    // sanitized error below is used instead — never a raw JSON.parse crash.
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
        // Claimed JSON but didn't parse — fall through to the raw (already non-secret) body text.
      }
      throw new Error(`Failed to get access token: ${response.status} ${response.statusText} — ${detail}`);
    }
    const preview = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      `Failed to get access token: non-JSON response ` +
        `(status=${response.status} ${response.statusText}, content-type="${contentType}", ` +
        `requestedUrl=${tokenUrl}, finalUrl=${response.url}, redirected=${response.redirected}). ` +
        `Body preview: "${preview}"`
    );
  }

  const data = await readJsonResponse<{ access_token: string }>(response, tokenUrl);
  return data.access_token;
}

async function graphRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();
  const baseUrl = "https://graph.microsoft.com/v1.0";
  const requestUrl = `${baseUrl}${path}`;

  const response = await fetch(requestUrl, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    // Sanitized: status/content-type/preview only, never the Authorization
    // header or any part of the token — a 401/403 body from Graph is JSON
    // (error.code/error.message) and safe to include in full; anything else
    // (e.g. an HTML error page from a gateway in front of Graph) is
    // truncated to a short preview instead of dumped whole.
    const bodyText = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") ?? "(none)";
    const detail = contentType.toLowerCase().includes("application/json")
      ? bodyText
      : bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      `Graph API error ${response.status} ${response.statusText} (content-type="${contentType}", url=${requestUrl}, finalUrl=${response.url}, redirected=${response.redirected}): ${detail}`
    );
  }

  if (response.status === 204) return undefined as T;
  return readJsonResponse<T>(response, requestUrl);
}

const MAILBOX = process.env.GRAPH_USER_EMAIL || "kinsenitsupport@kinsen.gr";

export const microsoftGraph = {
  /**
   * Fetch unread messages from the support inbox.
   */
  async getUnreadMessages(top = 25): Promise<GraphMailMessage[]> {
    const select = [
      "id", "subject", "bodyPreview", "body", "from", "toRecipients",
      "internetMessageId", "conversationId", "receivedDateTime",
      "hasAttachments", "isRead", "internetMessageHeaders",
    ].join(",");
    const data = await graphRequest<{ value: GraphMailMessage[] }>(
      `/users/${MAILBOX}/mailFolders/Inbox/messages?$filter=isRead eq false&$top=${top}&$orderby=receivedDateTime asc&$select=${select}&$expand=attachments`
    );
    return data.value;
  },

  /**
   * Mark a message as read.
   */
  async markAsRead(messageId: string): Promise<void> {
    await graphRequest(`/users/${MAILBOX}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
  },

  /**
   * Move a message to a specific folder (e.g., Processed).
   */
  async moveMessage(messageId: string, destinationFolderName: string): Promise<void> {
    const folders = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(
      `/users/${MAILBOX}/mailFolders?$filter=displayName eq '${destinationFolderName}'`
    );

    let folderId: string;

    if (folders.value.length === 0) {
      const newFolder = await graphRequest<{ id: string }>(
        `/users/${MAILBOX}/mailFolders`,
        {
          method: "POST",
          body: JSON.stringify({ displayName: destinationFolderName }),
        }
      );
      folderId = newFolder.id;
    } else {
      folderId = folders.value[0].id;
    }

    await graphRequest(`/users/${MAILBOX}/messages/${messageId}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: folderId }),
    });
  },

  /**
   * Send an email from the support mailbox.
   */
  async sendMail(payload: SendMailPayload): Promise<void> {
    await graphRequest(`/users/${MAILBOX}/sendMail`, {
      method: "POST",
      body: JSON.stringify({ ...payload, saveToSentItems: true }),
    });
  },

  /**
   * Validate Microsoft Graph credentials and mailbox access.
   * Returns structured result for the admin diagnostics panel.
   */
  async testConnection(): Promise<{
    tokenOk: boolean;
    mailboxOk: boolean;
    mailboxEmail?: string;
    unreadCount?: number;
    error?: string;
    details?: string;
  }> {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      return {
        tokenOk: false,
        mailboxOk: false,
        error: "Failed to acquire access token — check GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET",
        details: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const base = "https://graph.microsoft.com/v1.0";
      const hdrs = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const [profileRes, inboxRes] = await Promise.all([
        fetch(`${base}/users/${MAILBOX}?$select=mail,userPrincipalName`, { headers: hdrs }),
        fetch(
          `${base}/users/${MAILBOX}/mailFolders/Inbox/messages?$filter=isRead eq false&$top=1&$select=id`,
          { headers: hdrs }
        ),
      ]);

      if (!profileRes.ok) {
        const errText = await profileRes.text().catch(() => "");
        const errContentType = profileRes.headers.get("content-type") ?? "(none)";
        const details = errContentType.toLowerCase().includes("application/json")
          ? errText
          : `non-JSON response (content-type="${errContentType}", finalUrl=${profileRes.url}, redirected=${profileRes.redirected}): ${errText.replace(/\s+/g, " ").trim().slice(0, 200)}`;
        return {
          tokenOk: true,
          mailboxOk: false,
          error: `Mailbox access failed (HTTP ${profileRes.status}) — verify GRAPH_USER_EMAIL and Mail.Read permission`,
          details,
        };
      }

      const profile = await readJsonResponse<{ mail?: string; userPrincipalName?: string }>(profileRes, profileRes.url);
      const inbox = inboxRes.ok
        ? await readJsonResponse<{ value: unknown[] }>(inboxRes, inboxRes.url)
        : { value: [] };

      return {
        tokenOk: true,
        mailboxOk: true,
        mailboxEmail: profile.mail ?? profile.userPrincipalName ?? MAILBOX,
        unreadCount: inbox.value.length,
      };
    } catch (err) {
      return {
        tokenOk: true,
        mailboxOk: false,
        error: "Mailbox connectivity error",
        details: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * Send a ticket reply notification email.
   */
  async sendTicketReply(params: {
    to: string;
    toName?: string;
    subject: string;
    htmlBody: string;
    ticketNumber: number;
  }): Promise<void> {
    const { formatTicketNumber } = await import("@/lib/utils");
    const ref = formatTicketNumber(params.ticketNumber);

    await microsoftGraph.sendMail({
      message: {
        subject: params.subject.includes(ref) ? params.subject : `Re: [${ref}] ${params.subject}`,
        body: { contentType: "HTML", content: params.htmlBody },
        toRecipients: [
          {
            emailAddress: {
              address: params.to,
              name: params.toName,
            },
          },
        ],
        internetMessageHeaders: [
          { name: "X-Ticket-Number", value: ref },
          { name: "X-Ticket-ID", value: String(params.ticketNumber) },
        ],
      },
    });
  },
};

export type { GraphMailMessage, GraphAttachment };
