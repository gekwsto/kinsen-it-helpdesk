/**
 * Regression coverage for a real production incident: POST
 * /api/integrations/tickets was being redirected by NextAuth's middleware
 * to the HTML /login page (307, then a 200 HTML page once a client like
 * Postman auto-follows), because the endpoint wasn't in the middleware's
 * public-path allowlist — the route handler itself was never reached. A
 * route-level unit test alone can't catch this class of bug, since the
 * failure happens BEFORE the route handler runs — see lib/auth.config.ts's
 * `authorized()` callback, the actual decision function NextAuth's
 * middleware invokes for every request.
 *
 * Two layers of proof:
 *
 *  1. Direct tests of `authorized()` itself — the real decision logic, not
 *     a re-implementation of it — covering: the integration endpoint is
 *     bypassed with NO session; admin integration routes (API + page)
 *     remain session-protected; unrelated routes are untouched; the bypass
 *     is an EXACT pathname match, not a prefix (a lookalike path must NOT
 *     be granted bypass). No server needed — always runs.
 *
 *  2. Live end-to-end HTTP tests through a REAL running server (this
 *     project's own `npm run dev`), using curl with --max-redirs 0 so the
 *     FIRST real status/Location is observed (not whatever a client's
 *     auto-redirect-following would show) — proving the fix end-to-end,
 *     including that admin routes still redirect and unrelated API routes
 *     are unaffected. Skipped with a clear message if no server is
 *     reachable at TEST_BASE_URL (default http://localhost:3000).
 *
 * Usage: npx tsx scripts/test-integration-middleware-bypass.ts
 */
import { execFileSync } from "child_process";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/lib/auth.config";
import { generateIntegrationKey } from "@/lib/services/integration-key-service";

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

function makeRequest(pathname: string) {
  return { nextUrl: { pathname }, headers: new Headers(), method: "GET" } as any;
}

async function isAuthorized(pathname: string, isLoggedIn: boolean): Promise<boolean> {
  const auth = isLoggedIn ? { user: { email: `test-${RUN_ID}@kinsen.gr` } } : null;
  const result = await authConfig.callbacks!.authorized!({ auth, request: makeRequest(pathname) } as any);
  return result === true;
}

// Runs curl with --max-redirs 0 so the response reflects the FIRST hop
// only, exactly reproducing what Postman would see before it auto-follows.
function curlHeadersOnly(args: string[]): { status: number; headers: Record<string, string> } | null {
  let out: string;
  try {
    out = execFileSync("curl", ["-sS", "-i", "--max-redirs", "0", "--max-time", "5", ...args], { encoding: "utf8" });
  } catch (err: any) {
    // curl exits non-zero on some conditions but still writes output (e.g.
    // this isn't expected here since we never follow redirects), surface
    // stdout if present, otherwise treat as unreachable.
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

  check(
    "POST /api/integrations/tickets is bypassed with NO session (this is the bug: it used to be false)",
    await isAuthorized("/api/integrations/tickets", false)
  );
  check(
    "The bypass holds even WITH a session too (unconditional, not session-dependent)",
    await isAuthorized("/api/integrations/tickets", true)
  );

  check("GET /api/admin/integrations still requires a session", !(await isAuthorized("/api/admin/integrations", false)));
  check("GET /api/admin/integrations/[id] still requires a session", !(await isAuthorized("/api/admin/integrations/abc123", false)));
  check("POST /api/admin/integrations/[id]/rotate still requires a session", !(await isAuthorized("/api/admin/integrations/abc123/rotate", false)));
  check("The /admin/integrations PAGE still requires a session", !(await isAuthorized("/admin/integrations", false)));

  check("An unrelated API route (/api/tickets) is untouched — still requires a session", !(await isAuthorized("/api/tickets", false)));
  check("Another unrelated API route (/api/projects) is untouched", !(await isAuthorized("/api/projects", false)));

  // Exact-match proof — a startsWith("/api/integrations") style bypass
  // would incorrectly grant these too. They must NOT be bypassed.
  check(
    "A lookalike path (/api/integrations/ticketsomethingelse) is NOT granted bypass — exact match, not prefix",
    !(await isAuthorized("/api/integrations/ticketsomethingelse", false))
  );
  check(
    "A hypothetical sub-path (/api/integrations/tickets/extra) is NOT granted bypass",
    !(await isAuthorized("/api/integrations/tickets/extra", false))
  );
  check(
    "/api/integrations (no trailing segment) is NOT granted bypass",
    !(await isAuthorized("/api/integrations", false))
  );

  // Pre-existing public paths — untouched by this fix, confirmed as a
  // regression guard.
  check("/login remains public", await isAuthorized("/login", false));
  check("/api/auth/session remains public", await isAuthorized("/api/auth/session", false));
  check("/api/email/inbound remains public", await isAuthorized("/api/email/inbound", false));
  check("/unauthorized remains public", await isAuthorized("/unauthorized", false));

  // ── Layer 2: real HTTP through a running server, if one is up ─────────
  console.log(`\nLive HTTP end-to-end (via ${BASE_URL}, curl --max-redirs 0)...\n`);
  const probe = curlHeadersOnly([`${BASE_URL}/login`]);
  if (!probe) {
    console.log(`No server reachable at ${BASE_URL} — skipping the live HTTP section (start it with \`npm run dev\` to include this layer).`);
    printSummaryAndExit();
    return;
  }

  try {
    // No Authorization header at all -> must be a JSON 401, never a
    // redirect and never HTML — this is the exact symptom that was
    // reported (Postman auto-following a 307 to a 200 HTML /login page).
    const noAuth = curlFull([
      "-X", "POST", `${BASE_URL}/api/integrations/tickets`,
      "-H", "Content-Type: application/json",
      "--data", JSON.stringify({ externalReferenceId: `mw-test-${RUN_ID}-noauth`, requesterEmail: "mw-test@kinsen.gr", title: "Middleware bypass test", description: "No Authorization header at all." }),
    ]);
    check("No Authorization header -> first hop is 401 (not 307/302)", noAuth?.status === 401);
    check("No Authorization header -> Content-Type is application/json", !!noAuth?.headers["content-type"]?.includes("application/json"));
    check("No Authorization header -> no Location header (not a redirect)", !noAuth?.headers["location"]);
    check('No Authorization header -> body is the JSON error contract (code: "invalid_api_key")', (() => {
      try { return JSON.parse(noAuth!.body).code === "invalid_api_key"; } catch { return false; }
    })());

    // Invalid key -> same JSON 401 contract, never HTML.
    const badKey = curlFull([
      "-X", "POST", `${BASE_URL}/api/integrations/tickets`,
      "-H", "Authorization: Bearer tkint_not_a_real_key",
      "-H", "Content-Type: application/json",
      "--data", JSON.stringify({ externalReferenceId: `mw-test-${RUN_ID}-badkey`, requesterEmail: "mw-test@kinsen.gr", title: "Middleware bypass test", description: "Invalid Bearer key." }),
    ]);
    check("Invalid key -> 401 JSON, not HTML", badKey?.status === 401 && !!badKey?.headers["content-type"]?.includes("application/json"));

    // Admin routes: still real redirects to /login (session-protected,
    // unaffected by this fix).
    const adminList = curlHeadersOnly([`${BASE_URL}/api/admin/integrations`]);
    check("GET /api/admin/integrations (no session) -> 307 redirect to /login", adminList?.status === 307 && !!adminList?.headers["location"]?.startsWith("/login"));

    const adminPage = curlHeadersOnly([`${BASE_URL}/admin/integrations`]);
    check("GET /admin/integrations page (no session) -> 307 redirect to /login", adminPage?.status === 307 && !!adminPage?.headers["location"]?.startsWith("/login"));

    const adminRotate = curlHeadersOnly(["-X", "POST", `${BASE_URL}/api/admin/integrations/abc123/rotate`]);
    check("POST /api/admin/integrations/[id]/rotate (no session) -> 307 redirect to /login", adminRotate?.status === 307 && !!adminRotate?.headers["location"]?.startsWith("/login"));

    const unrelatedApi = curlHeadersOnly([`${BASE_URL}/api/tickets`]);
    check("GET /api/tickets (unrelated, no session) -> still 307 redirect to /login (matcher not broadened)", unrelatedApi?.status === 307 && !!unrelatedApi?.headers["location"]?.startsWith("/login"));

    // Full happy path with a REAL key, through the actual server —
    // proving the route is reached and persists correctly, not just that
    // middleware lets it through.
    const dept = await prisma.department.findFirst({ select: { id: true } });
    const key = generateIntegrationKey();
    const integration = await prisma.externalIntegration.create({
      data: { name: `MW Bypass Test ${RUN_ID}`, slug: `mw-bypass-test-${RUN_ID}`, departmentId: dept!.id, apiKeyPrefix: key.keyPrefix, apiKeyHash: key.keyHash },
    });
    const requesterEmail = `mw-bypass-requester-${RUN_ID}@example.com`;
    const refId = `mw-test-${RUN_ID}-realkey`;

    const created = curlFull([
      "-X", "POST", `${BASE_URL}/api/integrations/tickets`,
      "-H", `Authorization: Bearer ${key.rawKey}`,
      "-H", "Content-Type: application/json",
      "--data", JSON.stringify({ externalReferenceId: refId, requesterEmail, title: "Middleware bypass live test", description: "Real key through the real running server, past the real middleware." }),
    ]);
    check("Valid key through the live server -> 201, application/json", created?.status === 201 && !!created?.headers["content-type"]?.includes("application/json"));
    let ticketId: string | undefined;
    try {
      const body = JSON.parse(created!.body);
      check("Response body matches the documented contract (success/created/ticket.id/ticketNumber/url)", body.success === true && body.created === true && !!body.ticket?.id && typeof body.ticket?.ticketNumber === "number" && typeof body.ticket?.url === "string");
      ticketId = body.ticket?.id;
    } catch {
      check("Response body is valid JSON matching the documented contract", false);
    }

    const replay = curlFull([
      "-X", "POST", `${BASE_URL}/api/integrations/tickets`,
      "-H", `Authorization: Bearer ${key.rawKey}`,
      "-H", "Content-Type: application/json",
      "--data", JSON.stringify({ externalReferenceId: refId, requesterEmail, title: "Middleware bypass live test", description: "Real key through the real running server, past the real middleware." }),
    ]);
    check("Replay (same externalReferenceId) -> 200, created:false, application/json", (() => {
      if (replay?.status !== 200) return false;
      if (!replay?.headers["content-type"]?.includes("application/json")) return false;
      try { return JSON.parse(replay!.body).created === false; } catch { return false; }
    })());

    if (ticketId) {
      const dbTicket = await prisma.ticket.findUnique({
        where: { id: ticketId },
        include: { messages: true, history: true },
      });
      check("Ticket persisted with source: API and the correct integrationId", dbTicket?.source === "API" && dbTicket?.integrationId === integration.id);
      check("Ticket has its initial INBOUND TicketMessage", dbTicket?.messages.length === 1 && dbTicket.messages[0].direction === "INBOUND");
      check("Ticket has its initial CREATED TicketHistory row", dbTicket?.history.length === 1 && dbTicket.history[0].type === "CREATED");
      await prisma.ticket.deleteMany({ where: { id: ticketId } });
    }

    const integAfter = await prisma.externalIntegration.findUnique({ where: { id: integration.id }, select: { lastUsedAt: true } });
    check("ExternalIntegration.lastUsedAt was updated by the successful authenticated call", integAfter?.lastUsedAt !== null);

    await prisma.externalIntegration.deleteMany({ where: { id: integration.id } });
    await prisma.user.deleteMany({ where: { email: requesterEmail } });
  } catch (err) {
    console.error("Live HTTP section threw:", err instanceof Error ? err.message : err);
    failed++;
  } finally {
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
