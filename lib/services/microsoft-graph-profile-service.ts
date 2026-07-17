/**
 * Delegated-token Microsoft Graph client — fetches the signed-in user's own
 * profile via `GET /me` using the access token from their own OAuth sign-in.
 *
 * Not to be confused with lib/microsoft-graph.ts, which is a separate,
 * unrelated app-only/client-credentials integration used for shared-mailbox
 * email polling (different auth model entirely — that one impersonates a
 * mailbox with app permissions, this one acts as the signed-in user with
 * their own delegated User.Read permission).
 */

const GRAPH_ME_URL =
  "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,department,jobTitle";

const REQUEST_TIMEOUT_MS = 5000;

export interface GraphUserProfile {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  department: string | null;
  jobTitle: string | null;
}

export type GraphProfileFailureReason =
  | "no_token"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "malformed_response";

export type GraphProfileResult =
  | { ok: true; profile: GraphUserProfile }
  | { ok: false; reason: GraphProfileFailureReason; status?: number };

function isRawGraphUser(
  data: unknown
): data is Record<string, unknown> & { id: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).id === "string"
  );
}

function toGraphUserProfile(data: Record<string, unknown> & { id: string }): GraphUserProfile {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    id: data.id,
    displayName: str(data.displayName),
    mail: str(data.mail),
    userPrincipalName: str(data.userPrincipalName),
    department: str(data.department),
    jobTitle: str(data.jobTitle),
  };
}

/**
 * Fetches the caller's Graph profile with a delegated access token (from the
 * User.Read scope already requested by the Microsoft Entra ID provider).
 * Never throws — every failure mode is returned as a typed result so callers
 * don't need try/catch, and never logs or returns the access token itself.
 */
export async function fetchMicrosoftGraphProfile(
  accessToken?: string
): Promise<GraphProfileResult> {
  if (!accessToken) return { ok: false, reason: "no_token" };

  let response: Response;
  try {
    response = await fetch(GRAPH_ME_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (!response.ok) {
    if (response.status === 401) return { ok: false, reason: "unauthorized", status: 401 };
    if (response.status === 403) return { ok: false, reason: "forbidden", status: 403 };
    if (response.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
    return { ok: false, reason: "server_error", status: response.status };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, reason: "malformed_response" };
  }

  if (!isRawGraphUser(data)) return { ok: false, reason: "malformed_response" };

  return { ok: true, profile: toGraphUserProfile(data) };
}
