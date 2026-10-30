/**
 * Regression coverage for "SQLGeneral Worker 307 Login Redirect": in
 * production, POST /api/internal/sqlgeneral-user-sync/process with a valid
 * CRON_SECRET bearer token was redirected (307) to the HTML /login page
 * instead of ever reaching the route's own CRON_SECRET check — the exact
 * same class of bug as the pre-existing /api/integrations/tickets
 * incident covered by test-integration-middleware-bypass.ts. Root cause:
 * the route's pathname was missing from lib/auth.config.ts's PUBLIC_PATHS
 * allowlist, so the `authorized()` callback's "not logged in" branch
 * returned `false` for it, and NextAuth's own default behavior for that
 * is a redirect to `pages.signIn` — never a JSON 401/403, and the route
 * handler (which has its own real CRON_SECRET + timingSafeEqual
 * authorization) is never invoked at all.
 *
 * Auditing the OTHER three registered internal cron routes (vercel.json's
 * `crons` list) found the SAME gap on two more of them —
 * /api/internal/project-request-setup-reminders/process and
 * /api/internal/sqlgeneral-tree-snapshot/process — fixed identically.
 * Only /api/internal/mention-reminders/process was already covered.
 *
 * Two layers of proof, same structure as test-integration-middleware-bypass.ts:
 *  1. Direct tests of `authorized()` itself — the real decision logic — for
 *     all four internal cron routes, with no session and with one;
 *     unrelated/admin routes remain session-protected; the PRE-EXISTING
 *     mention-reminders bypass is untouched (regression guard).
 *  2. Live end-to-end HTTP tests through a REAL running server
 *     (`npm run dev`), using curl with --max-redirs 0, proving: valid
 *     CRON_SECRET reaches the route (no 307 anywhere in the chain); an
 *     invalid CRON_SECRET still gets a JSON 401 (never 307); and
 *     session-protected routes are completely unaffected. Skipped with a
 *     clear message if no server is reachable, or if CRON_SECRET isn't
 *     configured in this environment (the route's own dev-permissive
 *     fallback would make a "missing/invalid secret" assertion
 *     meaningless — see each route's own isAuthorized()).
 *
 * Usage: npx tsx scripts/test-internal-cron-middleware-bypass.ts
 */
import { execFileSync } from "child_process";
import { authConfig } from "@/lib/auth.config";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const RUN_ID = Date.now();
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

const INTERNAL_CRON_ROUTES = [
  "/api/internal/sqlgeneral-user-sync/process",
  "/api/internal/project-request-setup-reminders/process",
  "/api/internal/sqlgeneral-tree-snapshot/process",
  "/api/internal/mention-reminders/process",
];

function makeRequest(pathname: string) {
  return { nextUrl: { pathname }, headers: new Headers(), method: "GET" } as any;
}

async function isAuthorized(pathname: string, isLoggedIn: boolean): Promise<boolean> {
  const auth = isLoggedIn ? { user: { email: `test-${RUN_ID}@kinsen.gr` } } : null;
  const result = await authConfig.callbacks!.authorized!({ auth, request: makeRequest(pathname) } as any);
  return result === true;
}

function curlHeadersOnly(args: string[]): { status: number; headers: Record<string, string> } | null {
  let out: string;
  try {
    out = execFileSync("curl", ["-sS", "-i", "--max-redirs", "0", "--max-time", "5", ...args], { encoding: "utf8" });
  } catch (err: any) {
    if (err.stdout) out = err.stdout.toString();
    else return null;
  }
  const [statusLine, ...rest] = out.split("\r\n").join("\n").split("\n");
  const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
  if (!statusMatch) return null;
  const headers: Record<string, string> = {};
  for (const line of rest) {
    if (!line.trim()) break;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status: Number(statusMatch[1]), headers };
}

function curlFull(args: string[]): { status: number; headers: Record<string, string>; body: string } | null {
  let out: string;
  try {
    out = execFileSync("curl", ["-sS", "-i", "--max-redirs", "0", "--max-time", "5", ...args], { encoding: "utf8" });
  } catch (err: any) {
    if (err.stdout) out = err.stdout.toString();
    else return null;
  }
  const sepIndex = out.indexOf("\r\n\r\n") !== -1 ? out.indexOf("\r\n\r\n") : out.indexOf("\n\n");
  const headerPart = sepIndex !== -1 ? out.slice(0, sepIndex) : out;
  const body = sepIndex !== -1 ? out.slice(sepIndex).replace(/^[\r\n]+/, "") : "";
  const lines = headerPart.split(/\r?\n/);
  const statusMatch = lines[0]?.match(/HTTP\/[\d.]+\s+(\d+)/);
  if (!statusMatch) return null;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status: Number(statusMatch[1]), headers, body };
}

async function main() {
  // ── Layer 1: the real middleware decision function, no server needed ──
  console.log("\nMiddleware authorized() decision — the exact function NextAuth's middleware calls...\n");

  for (const route of INTERNAL_CRON_ROUTES) {
    check(`${route} is bypassed with NO session (the reported bug: it used to be false -> 307 to /login)`, await isAuthorized(route, false));
    check(`${route} bypass holds even WITH a session too (unconditional, not session-dependent)`, await isAuthorized(route, true));
  }

  check("Normal user routes retain Microsoft authentication: GET /api/tickets requires a session", !(await isAuthorized("/api/tickets", false)));
  check("Normal user routes retain Microsoft authentication: the /tickets PAGE requires a session", !(await isAuthorized("/tickets", false)));
  check("Normal user routes retain Microsoft authentication: GET /dashboard requires a session", !(await isAuthorized("/dashboard", false)));
  check("Admin routes still require a session: GET /api/admin/integrations", !(await isAuthorized("/api/admin/integrations", false)));

  // Boundary proof — startsWith matching (same semantics PUBLIC_PATHS
  // already used before this round) must not over-grant a lookalike or a
  // parent path that happens to share the prefix.
  check(
    "A lookalike path (/api/internal/sqlgeneral-user-syncXYZ) is NOT granted bypass",
    !(await isAuthorized("/api/internal/sqlgeneral-user-syncXYZ", false))
  );
  check(
    "The parent path without /process (/api/internal/sqlgeneral-user-sync) is NOT granted bypass on its own",
    !(await isAuthorized("/api/internal/sqlgeneral-user-sync", false))
  );
  check(
    "A sub-path under the bypassed route (/api/internal/sqlgeneral-user-sync/process/extra) IS covered (startsWith, same existing semantics as the pre-existing mention-reminders entry — not changed by this fix)",
    await isAuthorized("/api/internal/sqlgeneral-user-sync/process/extra", false)
  );

  // Pre-existing public paths — untouched by this fix, regression guard.
  check("/login remains public", await isAuthorized("/login", false));
  check("/api/email/inbound remains public", await isAuthorized("/api/email/inbound", false));
  check("/api/integrations/tickets remains publicly bypassed (the earlier, unrelated incident's fix)", await isAuthorized("/api/integrations/tickets", false));

  // ── Layer 2: real HTTP through a running server, if one is up ─────────
  console.log(`\nLive HTTP end-to-end (via ${BASE_URL}, curl --max-redirs 0)...\n`);
  const probe = curlHeadersOnly([`${BASE_URL}/login`]);
  if (!probe) {
    console.log(`No server reachable at ${BASE_URL} — skipping the live HTTP section (start it with \`npm run dev\` to include this layer).`);
    printSummaryAndExit();
    return;
  }

  // No Authorization header at all -> must never be a redirect (the exact
  // reported symptom). It may be 200 (dev-permissive fallback when
  // CRON_SECRET is unset locally) or 401 (CRON_SECRET configured) — either
  // is a correct, reachable response from the ROUTE itself, never 307.
  for (const route of INTERNAL_CRON_ROUTES) {
    const noAuth = curlHeadersOnly([`${BASE_URL}${route}`]);
    check(`${route}: no Authorization header -> never a redirect (first hop is not 307/302)`, !!noAuth && noAuth.status !== 307 && noAuth.status !== 302 && !noAuth.headers["location"]);
  }

  const hasCronSecret = !!process.env.CRON_SECRET;
  if (!hasCronSecret) {
    console.log("CRON_SECRET is not configured in this environment — skipping the valid/invalid-secret sub-checks (the route's own dev-permissive fallback would make them meaningless; see each route's isAuthorized()).");
  } else {
    for (const route of INTERNAL_CRON_ROUTES) {
      const validSecret = curlFull(["-X", "POST", `${BASE_URL}${route}`, "-H", `Authorization: Bearer ${process.env.CRON_SECRET}`]);
      check(`${route}: valid CRON_SECRET -> reaches the endpoint, no login redirect (status ${validSecret?.status})`, validSecret?.status !== 307 && validSecret?.status !== 302 && !validSecret?.headers["location"] && !!validSecret?.headers["content-type"]?.includes("application/json"));

      const invalidSecret = curlFull(["-X", "POST", `${BASE_URL}${route}`, "-H", "Authorization: Bearer definitely-not-the-real-secret"]);
      check(`${route}: invalid CRON_SECRET -> 401, never 307`, invalidSecret?.status === 401 && !invalidSecret?.headers["location"]);
    }
  }

  // Session-protected routes: still real redirects to /login, completely
  // unaffected by this fix (proves the matcher/bypass list wasn't broadened).
  const adminList = curlHeadersOnly([`${BASE_URL}/api/admin/integrations`]);
  check("GET /api/admin/integrations (no session) -> still 307 redirect to /login", adminList?.status === 307 && !!adminList?.headers["location"]?.startsWith("/login"));

  const unrelatedApi = curlHeadersOnly([`${BASE_URL}/api/tickets`]);
  check("GET /api/tickets (unrelated, no session) -> still 307 redirect to /login", unrelatedApi?.status === 307 && !!unrelatedApi?.headers["location"]?.startsWith("/login"));

  const dashboardPage = curlHeadersOnly([`${BASE_URL}/dashboard`]);
  check("GET /dashboard page (no session) -> still 307 redirect to /login", dashboardPage?.status === 307 && !!dashboardPage?.headers["location"]?.startsWith("/login"));

  printSummaryAndExit();
}

main();
