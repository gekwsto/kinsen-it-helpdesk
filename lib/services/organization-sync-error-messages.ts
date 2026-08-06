/**
 * Turns a sanitized `OrganizationSyncRun.lastError` string (written by
 * organization-sync-orchestrator.ts as `"<stage>: <reason>"`, where
 * `<reason>` is one of the typed DirectorySyncFailureReason values, or the
 * manager-sync-specific `"partial_fetch_failure"`) into a specific,
 * actionable admin-facing message — never a generic 500.
 *
 * PERMISSION CONTRACT (production correction pass — do not regress this):
 * `GET /users` and `GET /users/{id}/directReports` (the only two Application
 * Graph calls this feature makes — see organization-directory-sync-service.ts
 * and organization-manager-sync-service.ts) both accept ANY of `User.Read.All`,
 * `User.ReadWrite.All`, `Directory.Read.All`, `Directory.ReadWrite.All` as
 * Application permissions, per Microsoft Graph's own documented permissions
 * tables for "List users" and "List directReports". This app registration
 * already has Application `Directory.Read.All` consented — that already
 * satisfies both calls. A 403 here therefore does NOT mean "add
 * User.Read.All" (a real, valid tenant could easily have Directory.Read.All
 * revoked, or never granted, while having some OTHER one of the four
 * accepted roles, or none at all) — the message below never names one
 * specific permission as THE fix, it names the actual accepted set and
 * tells the admin to verify what's actually consented.
 */
export function describeOrganizationSyncFailure(lastError: string | null): { code: string; message: string } {
  if (!lastError) return { code: "sync_failed", message: "The organization sync failed for an unknown reason. Check the server logs for details." };

  if (lastError.includes("configuration_error")) {
    return {
      code: "graph_not_configured",
      message: "Microsoft Graph is not configured (GRAPH_TENANT_ID/GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET missing or invalid). Set these in your environment before syncing.",
    };
  }
  if (lastError.includes("no_permission")) {
    return {
      code: "graph_permission_missing",
      message:
        "Microsoft Graph rejected the request with 403 Forbidden. GET /users and GET /users/{id}/directReports (the two calls this feature makes) accept any of these Application permissions: User.Read.All, User.ReadWrite.All, Directory.Read.All, Directory.ReadWrite.All — verify the app registration has at least one of them consented (Directory.Read.All is the one this app already uses for other Microsoft Directory Sync features). This is unrelated to GET /users/{id}/manager, which this feature never calls (that endpoint does not support Application permissions at all, regardless of which role is granted).",
    };
  }
  if (lastError.includes("partial_fetch_failure")) {
    return {
      code: "manager_sync_incomplete",
      message:
        "The manager/reporting-line sync could not complete for every user this run (a directReports lookup failed and exhausted retries), so nothing was published — the previously synced organization hierarchy is still what's shown, unchanged. No partial or mixed manager data was written. Try syncing again; if this persists, check server logs for the specific failing user/status code.",
    };
  }
  if (lastError.includes("unauthorized")) {
    return {
      code: "graph_unauthorized",
      message: "Microsoft Graph rejected the application credentials (401). Verify GRAPH_CLIENT_ID/GRAPH_CLIENT_SECRET/GRAPH_TENANT_ID are correct and the client secret hasn't expired.",
    };
  }
  if (lastError.includes("rate_limited")) {
    return {
      code: "graph_rate_limited",
      message: "Microsoft Graph is throttling this sync (429) even after automatic retries. Try again in a few minutes.",
    };
  }
  if (lastError.includes("network_error")) {
    return {
      code: "graph_network_error",
      message: "Could not reach Microsoft Graph (network error). Check connectivity and try again.",
    };
  }
  return { code: "sync_failed", message: `The organization sync failed: ${lastError}` };
}
