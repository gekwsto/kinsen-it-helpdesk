/**
 * Minimal, safe real-tenant smoke test for the organization-sync feature's
 * ACTUAL Graph contract (production correction pass) — exercises exactly
 * the two Application Graph calls this feature makes in production
 * (lib/services/organization-directory-sync-service.ts,
 * lib/services/organization-manager-sync-service.ts) and nothing else.
 * Deliberately narrower than scripts/diagnose-organization-graph-fields.ts
 * (which samples many candidate fields for an open architectural
 * question) — this script exists specifically to let anyone with real
 * tenant credentials confirm, in under a second, that the corrected
 * contract actually works end to end: token roles, `GET /users`, and
 * `GET /users/{id}/directReports`. It never calls `GET /users/{id}/manager`
 * (that endpoint doesn't support Application permissions at all — see the
 * organization-manager-sync-service.ts header comment).
 *
 * NEVER writes/changes/deletes anything in Entra or this app's database —
 * every request is a GET, `$top=1` throughout. NEVER prints an access
 * token, client secret, or a real person's `displayName`/id value — only
 * status codes, booleans, and counts, matching every other diagnostic
 * script in this codebase.
 *
 * Usage: npx tsx --env-file=.env scripts/smoke-test-organization-graph-contract.ts
 */
import { getAppOnlyGraphAccessToken, GraphConfigurationError } from "@/lib/microsoft-graph";

export {}; // module scope isolation, same rationale as the other diagnostic scripts

type Status = "PASS" | "FAIL" | "SKIPPED";
interface Result {
  step: string;
  status: Status;
  detail: string;
}
const results: Result[] = [];

function record(step: string, status: Status, detail: string) {
  results.push({ step, status, detail });
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "•";
  console.log(`  ${icon} [${status}] ${step} — ${detail}`);
}

function decodeJwtPayloadSafe(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function main() {
  console.log("\n=== 1. Acquire application (client-credentials) token ===\n");
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch (err) {
    if (err instanceof GraphConfigurationError) {
      record("Acquire application token", "FAIL", `Graph not configured: ${err.message}`);
    } else {
      record("Acquire application token", "FAIL", err instanceof Error ? err.message : String(err));
    }
    printSummaryAndExit();
    return;
  }
  record("Acquire application token", "PASS", "token value never printed");

  const claims = decodeJwtPayloadSafe(token) ?? {};
  const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  console.log(`  Sanitized token role names: [${roles.join(", ") || "none"}]`);

  const ACCEPTED_ROLES = ["User.Read.All", "User.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"];
  const hasAcceptedRole = ACCEPTED_ROLES.some((r) => roles.includes(r));
  record(
    "Token has an Application permission accepted by GET /users and GET /users/{id}/directReports",
    hasAcceptedRole ? "PASS" : "FAIL",
    hasAcceptedRole ? `granted: [${ACCEPTED_ROLES.filter((r) => roles.includes(r)).join(", ")}]` : `none of [${ACCEPTED_ROLES.join(", ")}] present`
  );

  console.log("\n=== 2. GET /users?$top=1&$select=id,displayName ===\n");
  const headers = { Authorization: `Bearer ${token}` };
  let sampledUserId: string | null = null;
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/users?$top=1&$select=id,displayName", { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data.value) ? data.value.length : 0;
      const first = count > 0 ? data.value[0] : null;
      sampledUserId = first && typeof first.id === "string" ? first.id : null;
      record("GET /users", "PASS", `HTTP 200, ${count} user(s) returned, id present: ${!!sampledUserId}, displayName field present: ${first ? "id" in first === true && "displayName" in first : "n/a"} (values not printed)`);
    } else {
      record("GET /users", "FAIL", `HTTP ${res.status}`);
    }
  } catch (err) {
    record("GET /users", "FAIL", err instanceof Error ? err.message : String(err));
  }

  console.log("\n=== 3. GET /users/{id}/directReports?$select=id,displayName (the ONLY manager-relationship endpoint this feature calls) ===\n");
  if (!sampledUserId) {
    record("GET /users/{id}/directReports", "SKIPPED", "no sampled user id from step 2");
  } else {
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sampledUserId)}/directReports?$select=id,displayName`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data.value) ? data.value.length : 0;
        record("GET /users/{id}/directReports", "PASS", `HTTP 200, ${count} direct report(s) on the sampled user (ids/names not printed)`);
      } else if (res.status === 403) {
        record("GET /users/{id}/directReports", "FAIL", "HTTP 403 — see the accepted-role check in step 1");
      } else {
        record("GET /users/{id}/directReports", "FAIL", `HTTP ${res.status}`);
      }
    } catch (err) {
      record("GET /users/{id}/directReports", "FAIL", err instanceof Error ? err.message : String(err));
    }
  }

  printSummaryAndExit();
}

function printSummaryAndExit() {
  console.log("\n=== Summary ===\n");
  for (const r of results) console.log(`  [${r.status}] ${r.step}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  console.log(`\n${pass} PASS, ${fail} FAIL, ${skipped} SKIPPED`);
  console.log("\nNo Entra/Azure configuration, users, or application data was written, changed, or deleted by this script.");
  process.exit(fail > 0 && pass > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
