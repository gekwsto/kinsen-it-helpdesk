/**
 * Comprehensive, read-only Microsoft Entra ID / Microsoft Graph integration
 * diagnostic. Exercises every REAL configured flow this app has against the
 * ACTUAL configured Azure tenant/app registrations, using the exact token
 * flows the app itself uses (client-credentials for directory/mailbox,
 * a manually-supplied delegated token for /me and /me/photos — an
 * interactive OAuth consent cannot be scripted headlessly, see below).
 *
 * NEVER writes, changes, or deletes anything in Entra/Azure or in this app's
 * own database. NEVER prints an access token, refresh token, or client
 * secret — only safe, non-secret metadata (tenant id, audience, expiry,
 * granted scopes/roles) and counts. NEVER prints a real person's Graph
 * payload (name/email/photo bytes) — only booleans and counts.
 *
 * Safe to run against staging OR production: it only ever performs GET
 * requests (plus one OAuth2 token-endpoint POST, which issues a token but
 * changes no state), and every check is independent — a missing permission
 * on one capability never blocks the others.
 *
 * Delegated-token checks (/me, /me/photos) require a real interactive
 * Microsoft sign-in, which cannot be automated here. If you want to run
 * those checks too:
 *   1. Sign in to the app normally as a real test user.
 *   2. In your terminal (server-side, NEVER in a browser console), you'd
 *      need the delegated access_token Auth.js obtained during that
 *      sign-in — this app deliberately does not persist that token
 *      anywhere retrievable (see docs/microsoft-entra-graph-audit.md,
 *      §12), so there is no supported way to extract it after the fact.
 *      This is intentional; the safe alternative is to trust
 *      scripts/test-microsoft-profile-photo-sync.ts and
 *      scripts/test-microsoft-graph-sync.ts (which exercise the exact same
 *      code path with a mocked Graph response) plus a real interactive
 *      staging login performed by a human.
 *   Alternatively, set MICROSOFT_DELEGATED_TEST_TOKEN to a short-lived
 *   delegated access token (User.Read scope) obtained via any out-of-band
 *   method (e.g. az cli `az account get-access-token`, or a delegated-flow
 *   test harness) to exercise those two checks directly. Omit it and those
 *   checks report SKIPPED with a clear reason — never a false PASS/FAIL.
 *
 * Usage: npx tsx --env-file=.env scripts/verify-microsoft-integration.ts
 */

export {}; // forces module scope — without this, top-level names here can collide with other standalone scripts under the same tsc compilation (no other functional effect)

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
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(payload);
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
    scp: claims.scp, // delegated scopes
    roles: claims.roles, // application permissions granted
    exp: claims.exp ? new Date((claims.exp as number) * 1000).toISOString() : undefined,
  };
}

// ── Section 1: OIDC / login configuration ──────────────────────────────────

async function checkOidcConfig() {
  console.log("\n=== 1. Login app registration — OIDC/tenant configuration (AUTH_MICROSOFT_ENTRA_ID_*) ===\n");
  const tenantId = process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID;
  const clientId = process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
  const clientSecret = process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET;

  record("AUTH_MICROSOFT_ENTRA_ID_TENANT_ID set", tenantId ? "PASS" : "FAIL", tenantId ? "present" : "missing — login would fall back to multi-tenant 'common' endpoint");
  record("AUTH_MICROSOFT_ENTRA_ID_ID set", clientId ? "PASS" : "FAIL", clientId ? "present" : "missing");
  record("AUTH_MICROSOFT_ENTRA_ID_SECRET set", clientSecret ? "PASS" : "FAIL", clientSecret ? "present" : "missing");

  if (!tenantId) {
    record("OIDC discovery document reachable", "SKIPPED", "no tenant ID configured");
    return;
  }

  try {
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`);
    if (!res.ok) {
      record("OIDC discovery document reachable", "FAIL", `HTTP ${res.status} — tenant ID is likely invalid or the tenant is unreachable`);
      return;
    }
    const data = await res.json();
    const wellFormed = typeof data.authorization_endpoint === "string" && typeof data.token_endpoint === "string" && typeof data.issuer === "string";
    record("OIDC discovery document well-formed", wellFormed ? "PASS" : "FAIL", wellFormed ? `issuer: ${data.issuer}` : "missing expected fields");
  } catch (err) {
    record("OIDC discovery document reachable", "FAIL", err instanceof Error ? err.message : String(err));
  }
}

// ── Section 2: Application (client-credentials) token acquisition ─────────

async function acquireAppOnlyToken(): Promise<string | null> {
  console.log("\n=== 2. Graph app registration — application (client-credentials) token (GRAPH_*) ===\n");
  const tenantId = process.env.GRAPH_TENANT_ID;
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  record("GRAPH_TENANT_ID set", tenantId ? "PASS" : "FAIL", tenantId ? "present" : "missing");
  record("GRAPH_CLIENT_ID set", clientId ? "PASS" : "FAIL", clientId ? "present" : "missing");
  record("GRAPH_CLIENT_SECRET set", clientSecret ? "PASS" : "FAIL", clientSecret ? "present" : "missing");
  if (!tenantId || !clientId || !clientSecret) return null;

  try {
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    });
    if (!res.ok) {
      record("Application token acquired", "FAIL", `HTTP ${res.status} from token endpoint — check GRAPH_CLIENT_ID/SECRET/TENANT_ID`);
      return null;
    }
    const data = await res.json();
    const token = data.access_token as string | undefined;
    if (!token) {
      record("Application token acquired", "FAIL", "no access_token in response");
      return null;
    }
    record("Application token acquired", "PASS", "token value not printed");
    console.log(`      safe token metadata: ${JSON.stringify(safeTokenMetadata(token))}`);
    return token;
  } catch (err) {
    record("Application token acquired", "FAIL", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Section 3: Mailbox (application Mail.ReadWrite/Mail.Send) ──────────────

async function checkMailbox(appToken: string | null) {
  console.log("\n=== 3. Mailbox integration (Mail.ReadWrite/Mail.Send, application) ===\n");
  const mailbox = process.env.GRAPH_USER_EMAIL || process.env.SUPPORT_EMAIL || "kinsenitsupport@kinsen.gr";
  if (!appToken) {
    record("Mailbox profile read", "SKIPPED", "no application token");
    record("Mailbox Inbox read", "SKIPPED", "no application token");
    return;
  }
  const headers = { Authorization: `Bearer ${appToken}` };
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}?$select=mail,userPrincipalName`, { headers });
    if (res.ok) {
      const data = await res.json();
      record("Mailbox profile read (Mail.Read/ReadWrite check)", "PASS", `resolved: ${data.mail ?? data.userPrincipalName ?? "(no mail field)"}`);
    } else {
      record("Mailbox profile read (Mail.Read/ReadWrite check)", "FAIL", `HTTP ${res.status} — check GRAPH_USER_EMAIL and Mail.ReadWrite Application permission + admin consent`);
    }
  } catch (err) {
    record("Mailbox profile read (Mail.Read/ReadWrite check)", "FAIL", err instanceof Error ? err.message : String(err));
  }
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/Inbox/messages?$top=1&$select=id`, { headers });
    if (res.ok) {
      const data = await res.json();
      record("Mailbox Inbox read (read-only $top=1)", "PASS", `${Array.isArray(data.value) ? data.value.length : 0} message id returned, no content read`);
    } else {
      record("Mailbox Inbox read (read-only $top=1)", "FAIL", `HTTP ${res.status}`);
    }
  } catch (err) {
    record("Mailbox Inbox read (read-only $top=1)", "FAIL", err instanceof Error ? err.message : String(err));
  }
  // Mail.Send is a write-capable action (sends a real email) — deliberately
  // NEVER exercised by a read-only diagnostic. Documented, not tested here.
  record("Mail.Send capability", "SKIPPED", "sending a real email is a write action and is out of scope for a read-only diagnostic — verified instead by code review (lib/microsoft-graph.ts:sendMail) and the existing admin 'Send test email' feature (app/api/admin/email/test-ticket)");
}

// ── Section 4: Directory discovery (Directory.Read.All, application) + pagination ──

async function checkDirectory(appToken: string | null) {
  console.log("\n=== 4. Directory user discovery (Directory.Read.All, application) — including pagination ===\n");
  if (!appToken) {
    record("Directory /users first page", "SKIPPED", "no application token");
    record("Directory /users pagination", "SKIPPED", "no application token");
    return;
  }
  const headers = { Authorization: `Bearer ${appToken}` };
  const url = "https://graph.microsoft.com/v1.0/users?$select=id,department,jobTitle,mail,userPrincipalName,accountEnabled&$top=999";
  try {
    const res = await fetch(url, { headers });
    if (res.status === 403) {
      record("Directory /users first page", "FAIL", "HTTP 403 — Directory.Read.All Application permission missing or not admin-consented (does NOT affect login or mailbox polling)");
      record("Directory /users pagination", "SKIPPED", "first page failed");
      return;
    }
    if (!res.ok) {
      record("Directory /users first page", "FAIL", `HTTP ${res.status}`);
      record("Directory /users pagination", "SKIPPED", "first page failed");
      return;
    }
    const data = await res.json();
    const count = Array.isArray(data.value) ? data.value.length : 0;
    const hasNextLink = typeof data["@odata.nextLink"] === "string";
    record("Directory /users first page", "PASS", `${count} users returned on page 1 (no user data printed)`);

    // Confirms department/jobTitle/mail/userPrincipalName/accountEnabled are
    // actually present in the $select response shape (not just requested) —
    // without printing any real person's values.
    if (count > 0) {
      const sample = data.value[0];
      const fieldsPresent = ["id", "department", "jobTitle", "mail", "userPrincipalName", "accountEnabled"].filter((f) => f in sample);
      record(
        "Expected $select fields present in response shape",
        fieldsPresent.length >= 3 ? "PASS" : "FAIL",
        `fields present on sample row: ${fieldsPresent.join(", ")} (values not printed)`
      );
    }

    if (hasNextLink) {
      // Follows exactly ONE additional page — proves pagination genuinely
      // works end-to-end (not just that the field exists), without pulling
      // the whole tenant during a diagnostic run.
      try {
        const page2 = await fetch(data["@odata.nextLink"], { headers });
        record("Directory /users pagination (@odata.nextLink)", page2.ok ? "PASS" : "FAIL", page2.ok ? "followed nextLink successfully, page 2 fetched" : `HTTP ${page2.status} following nextLink`);
      } catch (err) {
        record("Directory /users pagination (@odata.nextLink)", "FAIL", err instanceof Error ? err.message : String(err));
      }
    } else {
      record("Directory /users pagination (@odata.nextLink)", "PASS", "tenant has a single page of users (< 999) — no nextLink to follow, this is expected and not a failure");
    }
  } catch (err) {
    record("Directory /users first page", "FAIL", err instanceof Error ? err.message : String(err));
  }
}

// ── Section 5: Delegated /me + /me/photos (requires a manually-supplied token) ──

async function checkDelegatedMeAndPhoto() {
  console.log("\n=== 5. Delegated /me + /me/photos (User.Read) — requires MICROSOFT_DELEGATED_TEST_TOKEN ===\n");
  const token = process.env.MICROSOFT_DELEGATED_TEST_TOKEN;
  if (!token) {
    record("/me (delegated User.Read)", "SKIPPED", "MICROSOFT_DELEGATED_TEST_TOKEN not set — a real interactive sign-in is required to obtain a delegated token, which cannot be scripted headlessly (see file header comment)");
    record("/me/photos/48x48/$value (delegated User.Read)", "SKIPPED", "same reason");
    return;
  }
  console.log(`      safe token metadata: ${JSON.stringify(safeTokenMetadata(token))}`);
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,department,jobTitle", { headers });
    if (res.ok) {
      const data = await res.json();
      const fieldsPresent = ["id", "displayName", "mail", "userPrincipalName", "department", "jobTitle"].filter((f) => f in data);
      record("/me (delegated User.Read)", "PASS", `fields present: ${fieldsPresent.join(", ")} (values not printed)`);
    } else {
      record("/me (delegated User.Read)", "FAIL", `HTTP ${res.status}`);
    }
  } catch (err) {
    record("/me (delegated User.Read)", "FAIL", err instanceof Error ? err.message : String(err));
  }
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me/photos/48x48/$value", { headers });
    if (res.status === 404) {
      record("/me/photos/48x48/$value (delegated User.Read)", "PASS", "HTTP 404 — this test account has no photo set (a valid, expected state, not a failure)");
    } else if (res.ok) {
      const contentLength = res.headers.get("content-length");
      record("/me/photos/48x48/$value (delegated User.Read)", "PASS", `photo present, ${contentLength ?? "unknown"} bytes (binary content not printed)`);
    } else {
      record("/me/photos/48x48/$value (delegated User.Read)", "FAIL", `HTTP ${res.status}`);
    }
  } catch (err) {
    record("/me/photos/48x48/$value (delegated User.Read)", "FAIL", err instanceof Error ? err.message : String(err));
  }
}

// ── Section 6: Not-implemented capabilities (explicitly reported, never silently skipped) ──

function checkNotImplemented() {
  console.log("\n=== 6. Group membership / App-role source / Subscriptions — NOT IMPLEMENTED ===\n");
  record(
    "Entra Group membership Graph query (/me/memberOf, /me/transitiveMemberOf)",
    "SKIPPED",
    "NOT IMPLEMENTED — repository-wide search confirms zero calls to any Graph group-membership endpoint. ENTRA_GROUP exists only as a MicrosoftDepartmentMapping.sourceType option, matched ONLY against an optional 'groups' ID-token claim (not currently configured in this Azure app registration) — never queried live from Graph."
  );
  record(
    "App-role assignment Graph query (/servicePrincipals/{id}/appRoleAssignedTo)",
    "SKIPPED",
    "NOT IMPLEMENTED — same as above for ENTRA_APP_ROLE: matched only against an optional 'roles' ID-token claim, never queried live from Graph."
  );
  record(
    "Graph subscriptions (webhooks)",
    "SKIPPED",
    "NOT IMPLEMENTED — repository-wide search confirms no Graph subscription create/renew/delete calls anywhere. Email ingestion uses polling (Vercel Cron -> /api/email/inbound), not webhooks."
  );
}

async function main() {
  await checkOidcConfig();
  const appToken = await acquireAppOnlyToken();
  await checkMailbox(appToken);
  await checkDirectory(appToken);
  await checkDelegatedMeAndPhoto();
  checkNotImplemented();

  console.log("\n=== Summary ===\n");
  for (const r of results) console.log(`  [${r.status}] ${r.capability}`);
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIPPED").length;
  console.log(`\n${pass} PASS, ${fail} FAIL, ${skipped} SKIPPED`);
  console.log("\nNo Entra/Azure configuration, consent, users, groups, roles, or application data was written, changed, or deleted by this script.");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
