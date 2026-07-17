/**
 * Offline test for the Microsoft Graph department sync pieces that don't
 * need a live Microsoft sign-in or a reachable database: the Graph fetch's
 * error classification (via a mocked global.fetch) and the pure
 * Graph-profile -> MicrosoftIdentityClaims mapper.
 *
 * Usage: npx tsx scripts/test-microsoft-graph-sync.ts
 */
import { fetchMicrosoftGraphProfile } from "@/lib/services/microsoft-graph-profile-service";
import { buildClaimsFromGraphProfile } from "@/lib/services/microsoft-department-sync-service";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function mockFetchOnce(impl: () => Promise<Response> | never) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async () => impl()) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

async function main() {
  console.log("Testing fetchMicrosoftGraphProfile...\n");

  console.log("no_token (no access token supplied):");
  const noToken = await fetchMicrosoftGraphProfile(undefined);
  check("reason is no_token", !noToken.ok && noToken.reason === "no_token");

  console.log("\nsuccess (valid Graph response, department present):");
  mockFetchOnce(async () =>
    jsonResponse(200, {
      id: "test-oid-lamprini",
      displayName: "Lamprini Faitaki",
      mail: "lamprini.faitaki@kinsen.gr",
      userPrincipalName: "lamprini.faitaki@kinsen.gr",
      department: "Systems Operations",
      jobTitle: "IT Operations Assistant",
    })
  );
  const success = await fetchMicrosoftGraphProfile("fake-token");
  check("ok is true", success.ok === true);
  check("department extracted", success.ok && success.profile.department === "Systems Operations");
  check("id extracted", success.ok && success.profile.id === "test-oid-lamprini");

  console.log("\nsuccess with null department (field genuinely empty):");
  mockFetchOnce(async () =>
    jsonResponse(200, {
      id: "test-oid-2",
      displayName: "No Department User",
      mail: null,
      userPrincipalName: "nodept@kinsen.gr",
      department: null,
      jobTitle: null,
    })
  );
  const emptyDept = await fetchMicrosoftGraphProfile("fake-token");
  check("ok is true", emptyDept.ok === true);
  check("department is null, not an error", emptyDept.ok && emptyDept.profile.department === null);

  console.log("\n401 unauthorized (expired/invalid token):");
  mockFetchOnce(async () => jsonResponse(401, { error: "InvalidAuthenticationToken" }));
  const unauthorized = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is unauthorized", !unauthorized.ok && unauthorized.reason === "unauthorized");
  check("status is 401", !unauthorized.ok && unauthorized.status === 401);

  console.log("\n403 forbidden (missing admin consent / permission):");
  mockFetchOnce(async () => jsonResponse(403, { error: "Authorization_RequestDenied" }));
  const forbidden = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is forbidden", !forbidden.ok && forbidden.reason === "forbidden");

  console.log("\n429 rate limited (throttling):");
  mockFetchOnce(async () => jsonResponse(429, { error: "TooManyRequests" }));
  const throttled = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is rate_limited", !throttled.ok && throttled.reason === "rate_limited");

  console.log("\n500 server error:");
  mockFetchOnce(async () => jsonResponse(500, { error: "InternalServerError" }));
  const serverError = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is server_error", !serverError.ok && serverError.reason === "server_error");
  check("status is 500", !serverError.ok && serverError.status === 500);

  console.log("\nnetwork error (fetch throws):");
  mockFetchOnce(async () => {
    throw new Error("network down");
  });
  const networkError = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is network_error", !networkError.ok && networkError.reason === "network_error");

  console.log("\nmalformed response (not valid JSON):");
  (global as unknown as { fetch: typeof fetch }).fetch = (async () =>
    new Response("not json", { status: 200 })) as typeof fetch;
  const malformed = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is malformed_response", !malformed.ok && malformed.reason === "malformed_response");

  console.log("\nmalformed response (valid JSON, missing id field):");
  mockFetchOnce(async () => jsonResponse(200, { displayName: "No Id User" }));
  const missingId = await fetchMicrosoftGraphProfile("fake-token");
  check("reason is malformed_response", !missingId.ok && missingId.reason === "malformed_response");

  console.log("\nTesting buildClaimsFromGraphProfile...\n");

  const claims = buildClaimsFromGraphProfile(
    { oid: "test-oid-lamprini", email: "lamprini.faitaki@kinsen.gr", name: "Lamprini Faitaki" },
    {
      id: "test-oid-lamprini",
      displayName: "Lamprini Faitaki",
      mail: "lamprini.faitaki@kinsen.gr",
      userPrincipalName: "lamprini.faitaki@kinsen.gr",
      department: "Systems Operations",
      jobTitle: "IT Operations Assistant",
    }
  );
  check("oid passed through", claims.oid === "test-oid-lamprini");
  check("email passed through", claims.email === "lamprini.faitaki@kinsen.gr");
  check("department mapped from Graph profile", claims.department === "Systems Operations");
  check("groups undefined when no fallback given", claims.groups === undefined);
  check("roles undefined when no fallback given", claims.roles === undefined);

  const claimsWithFallback = buildClaimsFromGraphProfile(
    {
      oid: "test-oid-3",
      email: "user3@kinsen.gr",
      fallbackGroups: ["IT-Team"],
      fallbackRoles: ["Admin"],
    },
    {
      id: "test-oid-3",
      displayName: null,
      mail: null,
      userPrincipalName: null,
      department: null,
      jobTitle: null,
    }
  );
  check("groups pass through untouched", claimsWithFallback.groups?.[0] === "IT-Team");
  check("roles pass through untouched", claimsWithFallback.roles?.[0] === "Admin");
  check("null department maps to null, not undefined", claimsWithFallback.department === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
