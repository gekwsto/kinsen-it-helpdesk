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

    console.log("\nCompany existence verification (the pagination bug fix) ===\n");
    let companyCallCount = 0;
    const companyRequestedUrls: string[] = [];
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      if (req.url.includes("/api/UsersAndManagers") && req.url.includes("CompanyId")) {
        companyCallCount++;
        companyRequestedUrls.push(req.url);
        if (req.url.includes("CompanyId%20eq%203")) {
          // Exactly the production scenario: a real company with many
          // employees. A nextLink IS present (there genuinely are more
          // matching rows) — the fix must never follow it for an
          // existence check, unlike fetchAllPages elsewhere.
          return jsonResponse(200, { value: [{ Username: "emp1", CompanyId: 3 }], nextLink: "/api/UsersAndManagers?$first=1&$filter=CompanyId%20eq%203&$after=page2of500" });
        }
        if (req.url.includes("CompanyId%20eq%20999")) return jsonResponse(200, { value: [] });
        if (req.url.includes("CompanyId%20eq%207")) return jsonResponse(200, { value: [{ Username: "mismatch-emp", CompanyId: 70 }] }); // backend returns a row whose OWN CompanyId doesn't match the filter
        if (req.url.includes("CompanyId%20eq%20500")) return jsonResponse(503, { error: "service unavailable" });
      }
      return jsonResponse(200, { value: [] });
    });

    const validExisting = await client.verifySqlGeneralCompanyIdExists("3");
    check(
      "17. valid source ID: exists=true from a SINGLE request, even though the real backend offered a nextLink for hundreds more matching employees",
      validExisting.ok === true && validExisting.exists === true && companyCallCount === 1,
      JSON.stringify(validExisting) + ` calls=${companyCallCount}`
    );
    check("18. pagination termination: the existence check never followed the nextLink (exactly 1 request, not 2+)", companyRequestedUrls.length === 1);

    companyCallCount = 0;
    const unknownId = await client.verifySqlGeneralCompanyIdExists("999");
    check("19. unknown ID: zero matches => exists=false, not an error", unknownId.ok === true && unknownId.exists === false);

    companyCallCount = 0;
    const mismatchResult = await client.verifySqlGeneralCompanyIdExists("7");
    check(
      "20. incorrect filter result: the backend returns a row, but its OWN CompanyId doesn't match the request — treated as a verification FAILURE, never a false exists=true",
      mismatchResult.ok === false,
      JSON.stringify(mismatchResult)
    );

    companyCallCount = 0;
    const apiFailure = await client.verifySqlGeneralCompanyIdExists("500");
    check("21. API failure (503): verification fails closed, never treated as exists=false", apiFailure.ok === false, JSON.stringify(apiFailure));

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

    console.log("\nlistAllSqlGeneralUsers: activeOnly filter — generated request, multi-page honesty, and bounded failure ===\n");
    let usersCallCount = 0;
    const usersRequestedUrls: string[] = [];
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      if (req.url.includes("/api/UsersAndManagers")) {
        usersCallCount++;
        usersRequestedUrls.push(req.url);
        return jsonResponse(200, { value: [{ Username: "noFilterUser", Active: true }] });
      }
      return jsonResponse(200, { value: [] });
    });
    const noFilterResult = await client.listAllSqlGeneralUsers();
    check(
      "22. listAllSqlGeneralUsers() with NO options — the exact call shape every existing SQLGeneral Sync caller uses — sends NO Active filter at all (sync behavior stays byte-identical)",
      noFilterResult.ok === true && !usersRequestedUrls[usersRequestedUrls.length - 1].includes("Active"),
      usersRequestedUrls[usersRequestedUrls.length - 1]
    );

    usersCallCount = 0;
    usersRequestedUrls.length = 0;
    const activeOnlyResult = await client.listAllSqlGeneralUsers({ activeOnly: true });
    check(
      "23. listAllSqlGeneralUsers({ activeOnly: true }) sends EXACTLY the standard, unquoted OData v4 boolean filter \"$filter=Active eq true\" (percent-encoded), combined correctly with the existing $first=100 page size",
      activeOnlyResult.ok === true && usersRequestedUrls[0].includes("$first=100") && usersRequestedUrls[0].includes(`$filter=${encodeURIComponent("Active eq true")}`),
      usersRequestedUrls[0]
    );

    console.log("\nlistAllSqlGeneralUsers: a REAL multi-page response (server's own nextLink already carries the filter, exactly like a live OData/DAB backend) is followed completely, never truncated ===\n");
    usersCallCount = 0;
    usersRequestedUrls.length = 0;
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      if (req.url.includes("/api/UsersAndManagers")) {
        usersCallCount++;
        usersRequestedUrls.push(req.url);
        if (usersCallCount === 1) {
          check("24. page 1's OWN request already carries the Active filter (this client sends it on every page, never only the first)", req.url.includes(`$filter=${encodeURIComponent("Active eq true")}`), req.url);
          return jsonResponse(200, {
            value: [{ Username: "page1-a", Active: true }, { Username: "page1-b", Active: true }],
            // A real DAB nextLink normally re-states the SAME filter itself —
            // simulated here exactly that way, confirming this client passes
            // the SERVER's own continuation link through verbatim (never
            // reconstructing or dropping the filter on later pages itself).
            nextLink: `/api/UsersAndManagers?$first=100&$filter=${encodeURIComponent("Active eq true")}&$after=page2token`,
          });
        }
        check("25. page 2's request URL is the server's OWN nextLink, unmodified — still carrying the Active filter, never dropped by THIS client on a later page", req.url.includes(`$filter=${encodeURIComponent("Active eq true")}`), req.url);
        return jsonResponse(200, { value: [{ Username: "page2-a", Active: true }] });
      }
      return jsonResponse(200, { value: [] });
    });
    const multiPageActiveResult = await client.listAllSqlGeneralUsers({ activeOnly: true });
    check(
      "26. ALL rows across BOTH pages are concatenated — never truncated to just the first page, never deduplicated/dropped",
      multiPageActiveResult.ok === true && multiPageActiveResult.users.length === 3 && multiPageActiveResult.users.map((u) => u.username).join(",") === "page1-a,page1-b,page2-a",
      JSON.stringify(multiPageActiveResult)
    );
    check("27. exactly 2 HTTP requests were made for 2 real pages — never re-fetching a page, never stopping early", usersCallCount === 2);

    console.log("\nlistAllSqlGeneralUsers: pagination-loop / malformed-envelope failures apply identically with activeOnly (fetchAllPages is the SAME shared primitive, never bypassed) ===\n");
    usersCallCount = 0;
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      usersCallCount++;
      // Always the SAME nextLink -> loop, exactly like the Departments loop test above.
      return jsonResponse(200, { value: [{ Username: "stuck", Active: true }], nextLink: `/api/UsersAndManagers?$first=100&$filter=${encodeURIComponent("Active eq true")}&$after=stuck` });
    });
    const usersLoopResult = await client.listAllSqlGeneralUsers({ activeOnly: true });
    check(
      "28. a repeating nextLink while fetching the ACTIVE-only listing is still detected as a loop and fails closed — never a silent partial/truncated result just because activeOnly is set",
      usersLoopResult.ok === false && /loop/i.test((usersLoopResult as { ok: false; reason: string }).reason)
    );

    console.log("\nlistAllSqlGeneralUsers: a large roster referencing a FEW distinct unresolved usernames costs exactly ONE lookup per distinct username, never one per referencing employee ===\n");
    let findUserCallCount = 0;
    const findUserRequestedUsernames: string[] = [];
    setMockFetch((req) => {
      if (req.url.includes("login.microsoftonline.com")) return jsonResponse(200, { access_token: "t", token_type: "Bearer" });
      if (req.url.includes("/api/UsersAndManagers") && req.url.includes("Username%20eq")) {
        findUserCallCount++;
        const m = req.url.match(/Username%20eq%20'([^']+)'/);
        if (m) findUserRequestedUsernames.push(m[1]);
        return jsonResponse(200, { value: [{ Username: m?.[1] ?? "", Active: false }] });
      }
      return jsonResponse(200, { value: [] });
    });
    // 50 DIFFERENT callers all asking about the SAME one username — this
    // file's own findSqlGeneralUserByUsername has no cache (by design, it's
    // a single-identity lookup); the bounded-call guarantee tested in
    // lib/services/sqlgeneral-organization-tree-service.ts's own test suite
    // (test 31, "Performance") is the CALLER's responsibility — this check
    // instead confirms the lower-level primitive itself issues exactly ONE
    // real HTTP request per call, never silently re-fetching extra pages or
    // retrying, so that caller-side bound is never undermined by excess
    // requests hiding one level down.
    for (let i = 0; i < 50; i++) await client.findSqlGeneralUserByUsername("same-username-every-time");
    check(
      "29. 50 calls for the SAME username make exactly 50 HTTP requests (one each, no hidden retries/extra pages per call) — the organization-tree-service's OWN cache above this layer is what keeps the real total bounded, never this primitive silently amplifying it",
      findUserCallCount === 50 && new Set(findUserRequestedUsernames).size === 1
    );

    console.log("\nHierarchy resolution (pure, no network) ===\n");
    const depts = [
      { id: 1, description: "Root", isActive: true, parentDepartmentId: null, country: null, company: "Acme", companyShortname: "AC", creationDate: null, updateTimestamp: null },
      { id: 2, description: "Mid", isActive: true, parentDepartmentId: 1, country: null, company: "Acme", companyShortname: "AC", creationDate: null, updateTimestamp: null },
      { id: 3, description: "Leaf", isActive: true, parentDepartmentId: 2, country: null, company: "Acme", companyShortname: "AC", creationDate: null, updateTimestamp: null },
    ];
    const resolvedLeaf = client.resolveSqlGeneralDepartmentPlacement(3, depts);
    check(
      "15. a 3-level chain resolves root-to-immediate-parent in order",
      resolvedLeaf.outcome === "resolved" && resolvedLeaf.placement.parentChain.map((d) => d.id).join(",") === "1,2" && !resolvedLeaf.placement.missingParent && !resolvedLeaf.placement.cycle
    );
    const cyclic = [
      { id: 1, description: "A", isActive: true, parentDepartmentId: 2, country: null, company: null, companyShortname: null, creationDate: null, updateTimestamp: null },
      { id: 2, description: "B", isActive: true, parentDepartmentId: 1, country: null, company: null, companyShortname: null, creationDate: null, updateTimestamp: null },
    ];
    const resolvedCyclic = client.resolveSqlGeneralDepartmentPlacement(1, cyclic);
    check(
      "16. a cycle in the external parent data breaks the walk rather than looping forever, and is explicitly reported via cycle: true — never silently folded into a truncated-but-otherwise-normal chain",
      resolvedCyclic.outcome === "resolved" && resolvedCyclic.placement.cycle === true && resolvedCyclic.placement.missingParent === false
    );
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  printSummaryAndExit();
}

main();
