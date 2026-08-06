/**
 * Read-only Microsoft Graph diagnostic for the organization-sync feature.
 * Samples a small, bounded number of real tenant users (default 5, capped at
 * 25) via the existing app-only (client-credentials) Graph token
 * (getAppOnlyGraphAccessToken, lib/microsoft-graph.ts — the SAME app
 * registration already used for mailbox polling and directory-value sync)
 * and reports FIELD COVERAGE only — never a real person's name, email,
 * job title, department string, or any other value. Also checks whether the
 * current application token's `roles` claim includes any Application
 * permission accepted by `GET /users`/`GET /users/{id}/directReports`
 * (User.Read.All, User.ReadWrite.All, Directory.Read.All, or
 * Directory.ReadWrite.All — this app already has Directory.Read.All, which
 * is sufficient; no new permission is required) without ever printing the
 * token itself.
 *
 * This script answers the organization-sync feature's open architectural
 * question: is there a more reliable Entra parent-child department signal
 * (employeeOrgData.division, employeeOrgData.costCenter,
 * onPremisesExtensionAttributes) than the `department` string TicketApp
 * already uses via MicrosoftDepartmentMapping? That can only be answered by
 * running this against the REAL tenant — in a dev environment with dummy
 * Azure credentials it will fail at token acquisition, which is the
 * expected, safe outcome (matches scripts/verify-microsoft-integration.ts's
 * behavior in the same environment), not a bug in this script.
 *
 * NEVER writes/changes/deletes anything in Entra or this app's database.
 * NEVER prints an access token, client secret, or any single user's PII.
 *
 * Usage: npx tsx --env-file=.env scripts/diagnose-organization-graph-fields.ts
 */

import { getAppOnlyGraphAccessToken, GraphConfigurationError } from "@/lib/microsoft-graph";

export {}; // module scope isolation — same rationale as verify-microsoft-integration.ts

const SAMPLE_SIZE = Math.min(25, Number(process.env.ORG_DIAGNOSTIC_SAMPLE_SIZE) || 5);

const CANDIDATE_FIELDS = [
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
] as const;

// Requested via $select as a top-level complex property; onPremisesExtensionAttributes
// is a nested object of up to 15 extensionAttribute1..15 string slots.
const EXTRA_SELECT_FIELDS = ["employeeOrgData", "onPremisesExtensionAttributes"] as const;

type Status = "PASS" | "FAIL" | "SKIPPED";
interface Result {
  capability: string;
  status: Status;
  detail: string;
}
const results: Result[] = [];

function record(capability: string, status: Status, detail: string) {
  results.push({ capability, status, detail });
  const icon = status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "•";
  console.log(`  ${icon} [${status}] ${capability} — ${detail}`);
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

function safeTokenMetadata(jwt: string): Record<string, unknown> {
  const claims = decodeJwtPayloadSafe(jwt) ?? {};
  return {
    tid: claims.tid,
    aud: claims.aud,
    appid: claims.appid ?? claims.azp,
    roles: claims.roles,
    exp: claims.exp ? new Date((claims.exp as number) * 1000).toISOString() : undefined,
  };
}

function pct(count: number, total: number): string {
  if (total === 0) return "n/a (0 sampled)";
  return `${Math.round((count / total) * 100)}%`;
}

async function acquireAppOnlyToken(): Promise<string | null> {
  console.log("\n=== 1. Application (client-credentials) token acquisition (GRAPH_*, same app registration as mailbox/directory sync) ===\n");
  let token: string;
  try {
    token = await getAppOnlyGraphAccessToken();
  } catch (err) {
    if (err instanceof GraphConfigurationError) {
      record("Application token acquired", "FAIL", `Graph not configured: ${err.message}`);
    } else {
      record("Application token acquired", "FAIL", err instanceof Error ? err.message : String(err));
    }
    return null;
  }
  record("Application token acquired", "PASS", "token value not printed");
  const meta = safeTokenMetadata(token);
  console.log(`      safe token metadata: ${JSON.stringify(meta)}`);

  // GET /users and GET /users/{id}/directReports (the only two Application
  // Graph calls this feature makes) both accept ANY of these four
  // Application permissions per Microsoft Graph's documented permissions
  // tables — there is no single "the" required role among them, and this
  // app registration already has Directory.Read.All consented for other
  // features. Never report a specific missing permission as a blocker when
  // any accepted one is already present.
  const ACCEPTED_USER_LISTING_ROLES = ["User.Read.All", "User.ReadWrite.All", "Directory.Read.All", "Directory.ReadWrite.All"];
  const roles = Array.isArray(meta.roles) ? (meta.roles as string[]) : [];
  const grantedAcceptedRoles = ACCEPTED_USER_LISTING_ROLES.filter((r) => roles.includes(r));
  record(
    `Token has an accepted Application permission for GET /users and GET /users/{id}/directReports (any of: ${ACCEPTED_USER_LISTING_ROLES.join(", ")})`,
    grantedAcceptedRoles.length > 0 ? "PASS" : "FAIL",
    grantedAcceptedRoles.length > 0
      ? `granted: [${grantedAcceptedRoles.join(", ")}] — no additional permission required for this feature`
      : `none of the accepted roles present — granted application roles: [${roles.join(", ") || "none"}]. Add one of the accepted roles above (Directory.Read.All is already used by this app's other Microsoft Directory Sync features, so it's the natural one to reuse — see the production-correction report's permission table).`
  );
  return token;
}

interface GraphSampleUser {
  id: string;
  accountEnabled?: boolean | null;
  userType?: string | null;
  department?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
  officeLocation?: string | null;
  employeeId?: string | null;
  employeeType?: string | null;
  displayName?: string | null;
  userPrincipalName?: string | null;
  mail?: string | null;
  employeeOrgData?: { costCenter?: string | null; division?: string | null } | null;
  onPremisesExtensionAttributes?: Record<string, string | null> | null;
}

async function sampleUsers(token: string): Promise<GraphSampleUser[] | null> {
  console.log(`\n=== 2. Sampling up to ${SAMPLE_SIZE} tenant users — field coverage only, no values printed ===\n`);
  const select = [...CANDIDATE_FIELDS, ...EXTRA_SELECT_FIELDS].join(",");
  const url = `https://graph.microsoft.com/v1.0/users?$select=${select}&$top=${SAMPLE_SIZE}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    record("GET /users sample", "FAIL", err instanceof Error ? err.message : String(err));
    return null;
  }
  if (res.status === 403) {
    record("GET /users sample", "FAIL", "HTTP 403 — Directory.Read.All (or User.Read.All) Application permission missing or not admin-consented");
    return null;
  }
  if (!res.ok) {
    record("GET /users sample", "FAIL", `HTTP ${res.status}`);
    return null;
  }
  let data: { value?: GraphSampleUser[] };
  try {
    data = await res.json();
  } catch {
    record("GET /users sample", "FAIL", "non-JSON response");
    return null;
  }
  const users = Array.isArray(data.value) ? data.value : [];
  record("GET /users sample", "PASS", `${users.length} users returned (no user data printed)`);
  return users;
}

function reportFieldCoverage(users: GraphSampleUser[]) {
  console.log("\n=== 3. Field coverage across the sample (% of sampled users with a non-empty value) ===\n");
  const total = users.length;
  if (total === 0) {
    record("Field coverage", "SKIPPED", "no users in sample");
    return;
  }

  const isPresent = (v: unknown) => v !== null && v !== undefined && v !== "";

  for (const field of CANDIDATE_FIELDS) {
    const count = users.filter((u) => isPresent((u as unknown as Record<string, unknown>)[field])).length;
    record(`Coverage: ${field}`, count > 0 ? "PASS" : "FAIL", `${count}/${total} (${pct(count, total)})`);
  }

  const divisionCount = users.filter((u) => isPresent(u.employeeOrgData?.division)).length;
  const costCenterCount = users.filter((u) => isPresent(u.employeeOrgData?.costCenter)).length;
  record("Coverage: employeeOrgData.division", divisionCount > 0 ? "PASS" : "FAIL", `${divisionCount}/${total} (${pct(divisionCount, total)})`);
  record("Coverage: employeeOrgData.costCenter", costCenterCount > 0 ? "PASS" : "FAIL", `${costCenterCount}/${total} (${pct(costCenterCount, total)})`);

  const extAttrCount = users.filter((u) => {
    const attrs = u.onPremisesExtensionAttributes;
    if (!attrs) return false;
    return Object.values(attrs).some((v) => isPresent(v));
  }).length;
  record(
    "Coverage: onPremisesExtensionAttributes (any of extensionAttribute1-15 populated)",
    extAttrCount > 0 ? "PASS" : "FAIL",
    `${extAttrCount}/${total} (${pct(extAttrCount, total)})`
  );

  console.log(
    "\n  Interpretation: a field with 0% coverage across the sample is either genuinely unused in this\n" +
      "  tenant or not populated for the sampled users — re-run with a larger ORG_DIAGNOSTIC_SAMPLE_SIZE\n" +
      "  before concluding a field is unusable. High, consistent coverage on employeeOrgData.division or\n" +
      "  onPremisesExtensionAttributes would be evidence (not proof) of a usable additional department\n" +
      "  mapping signal — that decision is intentionally NOT made automatically by this script."
  );
}

async function checkManagerAndDirectReports(token: string, users: GraphSampleUser[]) {
  console.log("\n=== 4. GET /users/{id}/directReports — the REAL check this feature relies on (Application-supported) ===\n");
  if (users.length === 0) {
    record("GET /users/{id}/directReports", "SKIPPED", "no sampled users");
  } else {
    const headers = { Authorization: `Bearer ${token}` };
    const sampleId = users[0].id;
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sampleId)}/directReports?$select=id&$top=1`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const count = Array.isArray(data.value) ? data.value.length : 0;
        record("GET /users/{id}/directReports", "PASS", `endpoint reachable, ${count} direct report(s) on this sampled user's first page (ids not printed) — this is the ONLY manager-relationship endpoint this feature calls`);
      } else if (res.status === 403) {
        record("GET /users/{id}/directReports", "FAIL", "HTTP 403 — none of the accepted Application permissions (User.Read.All, User.ReadWrite.All, Directory.Read.All, Directory.ReadWrite.All) are consented for this app registration. See section 1 above.");
      } else {
        record("GET /users/{id}/directReports", "FAIL", `HTTP ${res.status}`);
      }
    } catch (err) {
      record("GET /users/{id}/directReports", "FAIL", err instanceof Error ? err.message : String(err));
    }
  }

  console.log("\n=== 5. GET /users/{id}/manager — informational only, NOT used by this feature ===\n");
  console.log(
    "  Microsoft Graph's documented permissions table for \"Get manager\" lists NO Application permission at\n" +
      "  all (Delegated only: User.Read.All, User.ReadBasic.All, Directory.Read.All, Directory.AccessAsUser.All)\n" +
      "  — this codebase deliberately never calls this endpoint with an application token (see\n" +
      "  lib/services/organization-manager-sync-service.ts). Checked here only to empirically confirm that\n" +
      "  contract against this real tenant; the result has no effect on this script's PASS/FAIL summary."
  );
  if (users.length === 0) {
    console.log("  • [INFO] no sampled users — skipped");
  } else {
    const headers = { Authorization: `Bearer ${token}` };
    const sampleId = users[0].id;
    try {
      const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sampleId)}/manager?$select=id`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 403) {
        console.log("  • [INFO] HTTP 403 — this is the EXPECTED, documented outcome for an application token; confirms this codebase's decision to never rely on this endpoint is correct for this tenant.");
      } else if (res.ok) {
        console.log("  • [INFO] HTTP 200 — unexpectedly succeeded for an application token, despite Microsoft's documentation stating no Application permission is supported here. This script still never relies on this endpoint regardless (see directReports above).");
      } else {
        console.log(`  • [INFO] HTTP ${res.status}`);
      }
    } catch (err) {
      console.log(`  • [INFO] request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main() {
  const token = await acquireAppOnlyToken();
  if (!token) {
    console.log(
      "\nNo application token could be acquired — this is the expected, safe outcome in a dev environment\n" +
        "with placeholder/dummy GRAPH_* credentials (see docs/microsoft-production-readiness-audit.md).\n" +
        "Run this script with real Azure tenant credentials to get real field-coverage data. This feature\n" +
        "does not require any NEW Application permission — Directory.Read.All (already consented for this\n" +
        "app registration's other Microsoft Directory Sync features) already covers GET /users and\n" +
        "GET /users/{id}/directReports, the only two Application Graph calls this feature makes.\n"
    );
  } else {
    const users = await sampleUsers(token);
    if (users) {
      reportFieldCoverage(users);
      await checkManagerAndDirectReports(token, users);
    }
  }

  console.log("\n=== Summary ===\n");
  for (const r of results) console.log(`  [${r.status}] ${r.capability}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  console.log(`\n${pass} PASS, ${fail} FAIL, ${skipped} SKIPPED`);
  console.log("\nNo Entra/Azure configuration, users, or application data was written, changed, or deleted by this script.");
  // Never exit non-zero purely because of an unconfigured dev environment —
  // that's an expected, documented state, not a script defect. Only a real
  // in-band FAIL after a token was successfully acquired indicates a problem
  // worth a non-zero exit code (e.g. for CI gating).
  process.exit(token && fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
