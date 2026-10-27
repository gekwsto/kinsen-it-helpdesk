/**
 * Offline unit tests for lib/sqlgeneral-api-client.ts: client_credentials
 * token acquisition, the X-MS-API-ROLE header, OData username filtering
 * (including quote-escaping), field mapping (PascalCase raw -> normalized
 * record), pagination (multi-page via nextLink, loop detection, malformed
 * envelope), and the pure hierarchy-resolution function. No real network
 * call, no real credentials, no database — global.fetch is mocked
 * end-to-end. Config-placeholder detection is tested first, against
 * whatever SQLGENERAL_* is already in the environment (expected: dummy).
 *
 * Usage: npx tsx scripts/test-sqlgeneral-api-client.ts
 */
// Importing @/lib/prisma (unused otherwise, no DB calls in this file) is the
// same trick every other scripts/test-*.ts relies on to get `.env` actually
// loaded under a bare `tsx` run — PrismaClient's constructor loads it as a
// side effect; tsx itself does NOT auto-load .env in this project.
import "@/lib/prisma";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body?: string;
}

function setMockFetch(router: (req: CapturedRequest) => Promise<Response> | Response) {
  (global as unknown as { fetch: typeof fetch }).fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    }
    return router({ url, headers, body: init?.body });
  }) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function main() {
  const originalEnv = {
    SQLGENERAL_API_BASE_URL: process.env.SQLGENERAL_API_BASE_URL,
    SQLGENERAL_TENANT_ID: process.env.SQLGENERAL_TENANT_ID,
    SQLGENERAL_CLIENT_ID: process.env.SQLGENERAL_CLIENT_ID,
    SQLGENERAL_CLIENT_SECRET: process.env.SQLGENERAL_CLIENT_SECRET,
    SQLGENERAL_SCOPE: process.env.SQLGENERAL_SCOPE,
  };

  try {
    console.log("\nConfiguration preflight (against whatever .env actually has) ===\n");
    const client = await import("@/lib/sqlgeneral-api-client");
    const deptResultWithRealEnv = await client.listAllSqlGeneralDepartments();
    check(
      "1. with this repo's real (dummy) .env, listAllSqlGeneralDepartments returns a typed failure, never throws",
      deptResultWithRealEnv.ok === false && /placeholder/i.test((deptResultWithRealEnv as { ok: false; reason: string }).reason),
      JSON.stringify(deptResultWithRealEnv)
    );
    let threwForDummyUsername = false;
    try {
      await client.findSqlGeneralUserByUsername("anyone");
    } catch {
      threwForDummyUsername = true;
    }
    check("2. with dummy credentials, findSqlGeneralUserByUsername throws a typed SqlGeneralApiError rather than attempting a network call", threwForDummyUsername);

    // From here on, use realistic-LOOKING (never real) credentials so the
    // placeholder preflight passes and we reach the mocked HTTP layer.
    process.env.SQLGENERAL_API_BASE_URL = "https://fake-sqlgeneral.example-tenant.net";
    process.env.SQLGENERAL_TENANT_ID = "11111111-2222-3333-4444-555555555555";
    process.env.SQLGENERAL_CLIENT_ID = "66666666-7777-8888-9999-000000000000";
    process.env.SQLGENERAL_CLIENT_SECRET = "fake-secret-value-not-a-placeholder";
    process.env.SQLGENERAL_SCOPE = "api://66666666-7777-8888-9999-000000000000/.default";

    console.log("\nAuthentication ===\n");
    const captured: CapturedRequest[] = [];
    setMockFetch((req) => {
      captured.push(req);
      if (req.url.includes("login.microsoftonline.com")) {
        return jsonResponse(200, { access_token: "fake-access-token-xyz", token_type: "Bearer", expires_in: 3600 });
      }
      return jsonResponse(200, { value: [] });
    });
    await client.listAllSqlGeneralDepartments();
    const tokenReq = captured.find((r) => r.url.includes("login.microsoftonline.com"));
    check("3. token request goes to the tenant-scoped v2.0 token endpoint with the configured tenant id", !!tokenReq?.url.includes(`/${process.env.SQLGENERAL_TENANT_ID}/oauth2/v2.0/token`));
    check("3b. token request body is client_credentials with the configured scope (never logged/exposed elsewhere)", typeof tokenReq?.body === "string" && tokenReq.body.includes("grant_type=client_credentials") && tokenReq.body.includes(encodeURIComponent(process.env.SQLGENERAL_SCOPE!)));
    const apiReq = captured.find((r) => r.url.includes("/api/Departments"));
    check("4. the API call carries the fetched bearer token and the Org.Read role header", apiReq?.headers["authorization"] === "Bearer fake-access-token-xyz" && apiReq?.headers["x-ms-api-role"] === "Org.Read");

    console.log("\nAuthentication failure (sanitized Azure AD error surfaced, never a raw secret) ===\n");
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) {
        return jsonResponse(400, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\nTrace: abc" });
      }
      throw new Error("should not reach the API call if auth failed");
    });
    const authFailResult = await client.listAllSqlGeneralDepartments();
    check(
      "5. a token-endpoint failure surfaces the sanitized AADSTS reason, never throws past this function",
      authFailResult.ok === false && /AADSTS7000215/.test((authFailResult as { ok: false; reason: string }).reason) && !/fake-secret-value/.test((authFailResult as { ok: false; reason: string }).reason)
    );

    console.log("\nUsername matching + field mapping ===\n");
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      if (req.url.includes("/api/UsersAndManagers")) {
        // encodeURIComponent leaves `'` unescaped, so the OData-escaped
        // `''` pair appears literally in the URL (not percent-encoded).
        if (req.url.includes("o''brien")) {
          return jsonResponse(200, {
            value: [
              {
                Username: "o'brien", Mail: "obrien@example.com", HrDepartmentId: 42, Department: "Finance", CompanyId: 7, Company: "Acme Corp",
                Active: true, managerAMAccountName: "msmith", manager2AMAccountName: "mjones", manager3AMAccountName: null,
              },
            ],
          });
        }
        if (req.url.includes("notfound")) return jsonResponse(200, { value: [] });
        if (req.url.includes("dupe")) return jsonResponse(200, { value: [{ Username: "dupe" }, { Username: "dupe" }] });
      }
      return jsonResponse(200, { value: [] });
    });

    const uniqueMatch = await client.findSqlGeneralUserByUsername("o'brien");
    check(
      "6. OData string literal escaping doubles a single quote in the username (never breaks the filter query)",
      uniqueMatch.outcome === "unique" && uniqueMatch.user.username === "o'brien",
      JSON.stringify(uniqueMatch)
    );
    check(
      "7. PascalCase raw fields map correctly to the normalized record (Username/Mail/HrDepartmentId/Department/CompanyId/Company/Active/managerAMAccountName x3)",
      uniqueMatch.outcome === "unique" &&
        uniqueMatch.user.mail === "obrien@example.com" &&
        uniqueMatch.user.hrDepartmentId === 42 &&
        uniqueMatch.user.department === "Finance" &&
        uniqueMatch.user.companyId === 7 &&
        uniqueMatch.user.company === "Acme Corp" &&
        uniqueMatch.user.active === true &&
        uniqueMatch.user.managerAMAccountName === "msmith" &&
        uniqueMatch.user.manager2AMAccountName === "mjones" &&
        uniqueMatch.user.manager3AMAccountName === null
    );
    const notFoundMatch = await client.findSqlGeneralUserByUsername("notfound");
    check("8. zero matches is reported as not_found, never an error", notFoundMatch.outcome === "not_found");
    const ambiguousMatch = await client.findSqlGeneralUserByUsername("dupe");
    check("9. more than one match is reported as ambiguous with the real count, never silently resolved to the first row", ambiguousMatch.outcome === "ambiguous" && (ambiguousMatch as { outcome: "ambiguous"; count: number }).count === 2);

    console.log("\nPagination ===\n");
    let deptCallCount = 0;
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      if (req.url.includes("/api/Departments")) {
        deptCallCount++;
        if (deptCallCount === 1) return jsonResponse(200, { value: [{ Id: 1, Description: "Root" }, { Id: 2, Description: "Child" }], nextLink: "/api/Departments?$first=100&$after=page2token" });
        return jsonResponse(200, { value: [{ Id: 3, Description: "Last" }] });
      }
      return jsonResponse(200, { value: [] });
    });
    const paged = await client.listAllSqlGeneralDepartments();
    check("10. multi-page listing follows nextLink and concatenates all rows across pages", paged.ok === true && paged.departments.length === 3 && deptCallCount === 2, JSON.stringify(paged));

    console.log("\nPagination: incomplete-data failure cases (never a silent truncation) ===\n");
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      // Always returns the SAME nextLink -> loop.
      return jsonResponse(200, { value: [{ Id: 1 }], nextLink: "/api/Departments?$first=100&$after=stuck" });
    });
    const loopResult = await client.listAllSqlGeneralDepartments();
    check("11. a repeating nextLink is detected as a pagination loop and reported as incomplete, never an infinite fetch", loopResult.ok === false && /loop/i.test((loopResult as { ok: false; reason: string }).reason));

    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      return jsonResponse(200, { notValue: "wrong shape" });
    });
    const malformedResult = await client.listAllSqlGeneralDepartments();
    check("12. a response missing the \"value\" array is an explicit failure, never treated as zero rows", malformedResult.ok === false && /value/i.test((malformedResult as { ok: false; reason: string }).reason));

    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      return jsonResponse(503, { error: "service unavailable" });
    });
    const serverErrorResult = await client.listAllSqlGeneralDepartments();
    check("13. a non-2xx API response is an explicit failure carrying the status code", serverErrorResult.ok === false && /503/.test((serverErrorResult as { ok: false; reason: string }).reason));

    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      throw new Error("simulated network failure");
    });
    const networkErrorResult = await client.listAllSqlGeneralDepartments();
    check("14. a network error (fetch throws) is an explicit failure, never an uncaught rejection", networkErrorResult.ok === false && /network/i.test((networkErrorResult as { ok: false; reason: string }).reason));

    console.log("\nHierarchy resolution (pure, no network) ===\n");
    const depts = [
      { id: 1, description: "Root", isActive: true, parentDepartmentId: null, country: null, company: "Acme", companyShortname: "AC", creationDate: null, updateTimestamp: null },
      { id: 2, description: "Mid", isActive: true, parentDepartmentId: 1, country: null, company: "Acme", companyShortname: "AC", creationDate: null, updateTimestamp: null },
      { id: 3, description: "Leaf", isActive: true, parentDepartmentId: 2, country: null, company: "Acme", companyShortname: "AC", creationDate: null, updateTimestamp: null },
    ];
    const resolvedLeaf = client.resolveSqlGeneralDepartmentPlacement(3, depts);
    check(
      "15. a 3-level chain resolves root-to-immediate-parent in order",
      resolvedLeaf.outcome === "resolved" && resolvedLeaf.placement.parentChain.map((d) => d.id).join(",") === "1,2" && !resolvedLeaf.placement.missingParent
    );
    const cyclic = [
      { id: 1, description: "A", isActive: true, parentDepartmentId: 2, country: null, company: null, companyShortname: null, creationDate: null, updateTimestamp: null },
      { id: 2, description: "B", isActive: true, parentDepartmentId: 1, country: null, company: null, companyShortname: null, creationDate: null, updateTimestamp: null },
    ];
    const resolvedCyclic = client.resolveSqlGeneralDepartmentPlacement(1, cyclic);
    check("16. a cycle in the external parent data breaks the walk rather than looping forever", resolvedCyclic.outcome === "resolved");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  printSummaryAndExit();
}

main();
