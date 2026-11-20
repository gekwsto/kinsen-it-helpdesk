/**
 * Focused tests for the two production-readiness fixes added on top of
 * the Software Engineering AI Agent integration:
 *
 *   1. lib/services/integration-rate-limiter.ts — the shared, in-memory,
 *      per-integration rate limiter applied to both POST /api/
 *      integrations/tickets and POST /api/integrations/tickets/
 *      [ticketId]/attachments.
 *   2. lib/services/app-url-service.ts — APP_URL validation, used by the
 *      ticket-creation route to build `ticket.url`.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-integration-rate-limit-and-app-url.ts
 */
import { mock } from "node:test";
import { NextRequest } from "next/server";

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

const RUN_ID = Date.now();
const TAG = `irl-${RUN_ID}`;

async function main() {
  const realNextServer = await import("next/server");
  mock.module("next/server", {
    namedExports: { ...realNextServer, after: (_cb: () => unknown) => {} },
  });

  const { prisma } = await import("@/lib/prisma");
  const { generateIntegrationKey } = await import("@/lib/services/integration-key-service");
  const { ensureStatusForDepartment, STARTER_STATUSES } = await import("@/lib/services/config-starter-data");
  const { POST: ticketsPOST } = await import("@/app/api/integrations/tickets/route");
  const rateLimiter = await import("@/lib/services/integration-rate-limiter");
  const appUrlService = await import("@/lib/services/app-url-service");

  try {
    await prisma.$connect();
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    printSummaryAndExit();
    return;
  }
  if (!process.env.INTEGRATION_KEY_PEPPER) {
    console.log("INTEGRATION_KEY_PEPPER is not set — skipping.");
    printSummaryAndExit();
    return;
  }

  const departmentIds: string[] = [];
  const integrationIds: string[] = [];
  const userEmails: string[] = [];
  const ticketIds: string[] = [];

  function ticketReq(token: string | null, body: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    return new NextRequest("http://localhost/api/integrations/tickets", { method: "POST", headers, body: JSON.stringify(body) });
  }
  async function callTickets(token: string | null, body: unknown) {
    const res = await ticketsPOST(ticketReq(token, body));
    const json = await res.json();
    return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
  }

  try {
    // ════════════════════════════════════════════════════════════════
    // Part A — lib/services/integration-rate-limiter.ts, unit-level
    // ════════════════════════════════════════════════════════════════
    console.log("\n=== Rate limiter: unit-level ===\n");
    rateLimiter.resetIntegrationRateLimiterForTests();

    {
      const r1 = rateLimiter.checkIntegrationRateLimit("int-A", "ticket_creation", { limit: 2, windowMs: 60_000, now: 1000 });
      const r2 = rateLimiter.checkIntegrationRateLimit("int-A", "ticket_creation", { limit: 2, windowMs: 60_000, now: 1000 });
      const r3 = rateLimiter.checkIntegrationRateLimit("int-A", "ticket_creation", { limit: 2, windowMs: 60_000, now: 1000 });
      check("Call 1 within limit -> allowed", r1.allowed === true);
      check("Call 2 within limit -> allowed", r2.allowed === true);
      check("Call 3 over limit -> blocked", r3.allowed === false);
      check("Blocked result carries a positive retryAfterSeconds", !r3.allowed && r3.retryAfterSeconds > 0);
    }
    rateLimiter.resetIntegrationRateLimiterForTests();
    {
      // Independent scopes — ticket_creation exhausted must never affect
      // attachment_upload's own, separate bucket for the SAME integration id.
      rateLimiter.checkIntegrationRateLimit("int-B", "ticket_creation", { limit: 1, windowMs: 60_000, now: 1000 });
      const exhausted = rateLimiter.checkIntegrationRateLimit("int-B", "ticket_creation", { limit: 1, windowMs: 60_000, now: 1000 });
      const otherScope = rateLimiter.checkIntegrationRateLimit("int-B", "attachment_upload", { limit: 1, windowMs: 60_000, now: 1000 });
      check("ticket_creation bucket exhausted for int-B", exhausted.allowed === false);
      check("attachment_upload bucket for the SAME integration id is unaffected", otherScope.allowed === true);
    }
    rateLimiter.resetIntegrationRateLimiterForTests();
    {
      // Independent integrations — integration C exhausted must never
      // affect integration D's own bucket.
      rateLimiter.checkIntegrationRateLimit("int-C", "ticket_creation", { limit: 1, windowMs: 60_000, now: 1000 });
      const cBlocked = rateLimiter.checkIntegrationRateLimit("int-C", "ticket_creation", { limit: 1, windowMs: 60_000, now: 1000 });
      const dAllowed = rateLimiter.checkIntegrationRateLimit("int-D", "ticket_creation", { limit: 1, windowMs: 60_000, now: 1000 });
      check("Integration C's own bucket is exhausted", cBlocked.allowed === false);
      check("A DIFFERENT integration (D) has its own, unaffected bucket", dAllowed.allowed === true);
    }
    rateLimiter.resetIntegrationRateLimiterForTests();
    {
      // Window reset: once windowMs has elapsed, the count restarts.
      rateLimiter.checkIntegrationRateLimit("int-E", "ticket_creation", { limit: 1, windowMs: 1000, now: 1000 });
      const withinWindow = rateLimiter.checkIntegrationRateLimit("int-E", "ticket_creation", { limit: 1, windowMs: 1000, now: 1500 });
      const afterWindow = rateLimiter.checkIntegrationRateLimit("int-E", "ticket_creation", { limit: 1, windowMs: 1000, now: 2001 });
      check("Still within the same window -> blocked", withinWindow.allowed === false);
      check("After the window elapses -> allowed again", afterWindow.allowed === true);
    }
    rateLimiter.resetIntegrationRateLimiterForTests();
    {
      check("Bucket map starts empty after a reset", rateLimiter.getIntegrationRateLimiterSizeForTests("ticket_creation") === 0);
      rateLimiter.checkIntegrationRateLimit("int-F", "ticket_creation", { limit: 5, windowMs: 60_000, now: 1000 });
      rateLimiter.checkIntegrationRateLimit("int-F", "ticket_creation", { limit: 5, windowMs: 60_000, now: 1000 });
      rateLimiter.checkIntegrationRateLimit("int-G", "ticket_creation", { limit: 5, windowMs: 60_000, now: 1000 });
      check("Map size grows by distinct integration id only (2 ids -> size 2, regardless of call count)", rateLimiter.getIntegrationRateLimiterSizeForTests("ticket_creation") === 2);
    }
    rateLimiter.resetIntegrationRateLimiterForTests();

    // ════════════════════════════════════════════════════════════════
    // Part B — rate limiting through the REAL ticket-creation route
    // ════════════════════════════════════════════════════════════════
    console.log("\n=== Rate limiting through the real route ===\n");

    const dept = await prisma.department.create({ data: { name: `${TAG}-dept`, slug: `${TAG}-dept` } });
    departmentIds.push(dept.id);
    await ensureStatusForDepartment(prisma, dept.id, STARTER_STATUSES[0]);

    const key1 = generateIntegrationKey();
    const integration1 = await prisma.externalIntegration.create({
      data: { name: `${TAG}-int-1`, slug: `${TAG}-int-1`, departmentId: dept.id, apiKeyPrefix: key1.keyPrefix, apiKeyHash: key1.keyHash },
    });
    integrationIds.push(integration1.id);

    const savedTicketLimit = process.env.INTEGRATION_TICKET_RATE_LIMIT_PER_MINUTE;
    process.env.INTEGRATION_TICKET_RATE_LIMIT_PER_MINUTE = "2";
    rateLimiter.resetIntegrationRateLimiterForTests();
    try {
      const requesterEmail = `${TAG}-requester@example.com`;
      userEmails.push(requesterEmail);
      const r1 = await callTickets(key1.rawKey, { externalReferenceId: `${TAG}-ref-1`, requesterEmail, title: "First ticket", description: "Within the configured limit of 2." });
      const r2 = await callTickets(key1.rawKey, { externalReferenceId: `${TAG}-ref-2`, requesterEmail, title: "Second ticket", description: "Still within the configured limit of 2." });
      const r3 = await callTickets(key1.rawKey, { externalReferenceId: `${TAG}-ref-3`, requesterEmail, title: "Third ticket", description: "Over the configured limit of 2." });
      check("Call 1 (limit=2) -> 201", r1.status === 201);
      check("Call 2 (limit=2) -> 201", r2.status === 201);
      check("Call 3 (limit=2) -> 429 rate_limited", r3.status === 429 && r3.json.code === "rate_limited");
      check("429 response carries a Retry-After header", r3.retryAfter !== null && Number(r3.retryAfter) > 0);
      if (r1.json.ticket?.id) ticketIds.push(r1.json.ticket.id);
      if (r2.json.ticket?.id) ticketIds.push(r2.json.ticket.id);
      const ticketCountAfterRateLimit = await prisma.ticket.count({ where: { externalReferenceId: `${TAG}-ref-3` } });
      check("The rate-limited (3rd) request created NO ticket", ticketCountAfterRateLimit === 0);
    } finally {
      if (savedTicketLimit === undefined) delete process.env.INTEGRATION_TICKET_RATE_LIMIT_PER_MINUTE;
      else process.env.INTEGRATION_TICKET_RATE_LIMIT_PER_MINUTE = savedTicketLimit;
      rateLimiter.resetIntegrationRateLimiterForTests();
    }

    // Invalid-auth attempts must never grow the limiter's state.
    {
      for (let i = 0; i < 5; i++) {
        await callTickets("not-a-real-key", { externalReferenceId: `${TAG}-bad-${i}`, requesterEmail: "x@example.com", title: "Should never reach the limiter", description: "Invalid key." });
      }
      check("5 invalid-key attempts created zero rate-limiter bucket entries", rateLimiter.getIntegrationRateLimiterSizeForTests("ticket_creation") === 0);
    }
    rateLimiter.resetIntegrationRateLimiterForTests();

    // ════════════════════════════════════════════════════════════════
    // Part C — lib/services/app-url-service.ts, unit-level
    // ════════════════════════════════════════════════════════════════
    console.log("\n=== APP_URL validation: unit-level ===\n");
    {
      const origin = appUrlService.resolveAppOrigin({ rawAppUrl: "https://helpdesk.example.com", nodeEnv: "production" });
      check("Valid https URL in production -> accepted", origin === "https://helpdesk.example.com");
    }
    {
      const origin = appUrlService.resolveAppOrigin({ rawAppUrl: "http://localhost:3000", nodeEnv: "development" });
      check("http:// permitted outside production", origin === "http://localhost:3000");
    }
    {
      const origin = appUrlService.resolveAppOrigin({ rawAppUrl: "http://localhost:3000", nodeEnv: "production" });
      check("http://localhost permitted even when NODE_ENV=production (local prod-build testing)", origin === "http://localhost:3000");
    }
    {
      let threw = false;
      try {
        appUrlService.resolveAppOrigin({ rawAppUrl: "http://helpdesk.example.com", nodeEnv: "production" });
      } catch (e) {
        threw = e instanceof appUrlService.AppUrlMisconfiguredError;
      }
      check("http:// on a real public host in production -> AppUrlMisconfiguredError", threw);
    }
    {
      let threw = false;
      try {
        appUrlService.resolveAppOrigin({ rawAppUrl: "not a valid url at all", nodeEnv: "production" });
      } catch (e) {
        threw = e instanceof appUrlService.AppUrlMisconfiguredError;
      }
      check("Malformed APP_URL (not a URL at all) -> AppUrlMisconfiguredError", threw);
    }
    {
      let threw = false;
      try {
        appUrlService.resolveAppOrigin({ rawAppUrl: "ftp://helpdesk.example.com", nodeEnv: "production" });
      } catch (e) {
        threw = e instanceof appUrlService.AppUrlMisconfiguredError;
      }
      check("Non-http(s) scheme -> AppUrlMisconfiguredError", threw);
    }
    {
      // Trailing slash / stray path normalization via the URL API's .origin.
      const origin = appUrlService.resolveAppOrigin({ rawAppUrl: "https://helpdesk.example.com/some/stray/path/", nodeEnv: "production" });
      check("Trailing slash / stray path normalized away -> clean origin only", origin === "https://helpdesk.example.com");
      const built = appUrlService.buildAbsoluteAppUrl("/tickets/abc123", { rawAppUrl: "https://helpdesk.example.com/some/stray/path/", nodeEnv: "production" });
      check("buildAbsoluteAppUrl produces a clean, correctly-joined URL (no doubled/missing slashes)", built === "https://helpdesk.example.com/tickets/abc123");
    }

    // ════════════════════════════════════════════════════════════════
    // Part D — APP_URL validation through the REAL route: detected
    // BEFORE ticket creation, never after
    // ════════════════════════════════════════════════════════════════
    console.log("\n=== APP_URL validation through the real route ===\n");
    const savedAppUrl = process.env.APP_URL;
    process.env.APP_URL = "this is not a url";
    try {
      const requesterEmail = `${TAG}-appurl-requester@example.com`;
      userEmails.push(requesterEmail);
      const refId = `${TAG}-ref-appurl`;
      const { status, json } = await callTickets(key1.rawKey, { externalReferenceId: refId, requesterEmail, title: "Should never be created", description: "APP_URL is misconfigured for this call." });
      check("Malformed APP_URL -> 503 configuration_required (never 500, never a partial success)", status === 503 && json.code === "configuration_required");
      const ticketCount = await prisma.ticket.count({ where: { externalReferenceId: refId } });
      check("NO ticket was created despite the failure happening mid-request (validated before creation, not after)", ticketCount === 0);
    } finally {
      if (savedAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = savedAppUrl;
    }

    // Confirm the route works normally again once APP_URL is restored.
    {
      const requesterEmail = `${TAG}-appurl-recovery@example.com`;
      userEmails.push(requesterEmail);
      const { status, json } = await callTickets(key1.rawKey, { externalReferenceId: `${TAG}-ref-recovery`, requesterEmail, title: "Recovery ticket", description: "APP_URL restored to a valid value." });
      check("Recovers cleanly once APP_URL is valid again -> 201", status === 201);
      check("ticket.url is absolute and matches the (restored) configured origin", typeof json.ticket?.url === "string" && json.ticket.url.startsWith((process.env.APP_URL || "http://localhost:3000") + "/tickets/"));
      if (json.ticket?.id) ticketIds.push(json.ticket.id);
    }
  } catch (err) {
    console.log("Unexpected error:", err instanceof Error ? err.stack : err);
    failed++;
  } finally {
    console.log("\nCleaning up test data...\n");
    rateLimiter.resetIntegrationRateLimiterForTests();
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["integrations", () => prisma.externalIntegration.deleteMany({ where: { id: { in: integrationIds } } })],
      ["users", () => (userEmails.length > 0 ? prisma.user.deleteMany({ where: { email: { in: userEmails } } }) : Promise.resolve())],
      ["statuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: departmentIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
    await prisma.$disconnect();
  }

  printSummaryAndExit();
}

main();
