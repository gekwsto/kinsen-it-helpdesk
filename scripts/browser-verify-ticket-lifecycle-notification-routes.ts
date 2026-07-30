/**
 * Route-level wiring verification for the ticket created/closed lifecycle
 * notifications — real HTTP against a live `npm run dev` server, proving
 * each of the 5 real call sites actually invokes the central notification
 * functions on the correct transition:
 *   - POST /api/tickets                          (WEB creation)
 *   - POST /api/tickets/pending/[id]/accept       (EMAIL creation, on Accept)
 *   - PATCH /api/tickets/[id]/status              (closing)
 *   - POST /api/tickets/[id]/cancel               (closing)
 *   - PATCH /api/tickets/[id]                     (generic edit, closing)
 *
 * Deliberately does NOT test the deep SENT/FAILED/idempotency behavior of
 * the notification functions themselves — that's
 * scripts/test-ticket-lifecycle-notifications.ts, with a monkey-patched
 * Graph client. This script instead uses a requester whose email matches
 * the no-reply local-part filter (isNotifiableEmail) on EVERY ticket it
 * creates, so every single notification attempt here structurally MUST
 * resolve to SKIPPED before ever reaching microsoftGraph.sendMail — no real
 * Graph credentials or network call is reachable from this script at all,
 * regardless of what's configured in this environment's .env. What's
 * actually being checked is that the right EmailNotificationLog row (type,
 * eventKey shape) appears after each real HTTP call.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-lifecycle-notification-routes.ts
 */
import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider, DepartmentRole, MembershipSource, TicketSource } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const TEST_PASSWORD = "TestPassword123!";
// Must be BOTH an exact entry in NO_REPLY_LOCAL_PARTS (isNotifiableEmail
// only does an exact Set match on the local part, not a prefix/pattern
// match — "no-reply+anything" would NOT match) AND end in
// @<ALLOWED_EMAIL_DOMAIN> ("kinsen.gr" — see lib/auth.config.ts's
// `authorized` callback, which middleware uses to gate every non-public
// route regardless of session validity). Those two constraints leave no
// room for a RUN_ID-uniquified local part, so this is a fixed, singleton
// fixture identity for this script only (same precedent as the
// well-known ADMIN_EMAIL/USER_EMAIL test accounts used elsewhere in this
// codebase's own scripts) — defensively deleted before AND after use so a
// crashed prior run can't collide with this one.
const NOREPLY_EMAIL = "no-reply@kinsen.gr";

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

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
  await page.click('button:has-text("Sign in as Admin")');
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 });
}

async function main() {
  await prisma.$connect();

  let dept: Awaited<ReturnType<typeof prisma.department.create>> | undefined;
  let openStatus: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let closedStatus1: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let closedStatus2: Awaited<ReturnType<typeof prisma.ticketStatus.create>> | undefined;
  let cancelReason: Awaited<ReturnType<typeof prisma.ticketCancelReason.create>> | undefined;
  let actor: Awaited<ReturnType<typeof prisma.user.create>> | undefined;
  const ticketIds: string[] = [];
  const pendingIds: string[] = [];

  const browser = await chromium.launch();
  try {
    // Defensive: a crashed prior run could have left the fixed NOREPLY_EMAIL
    // identity behind (its own finally block runs a real delete, but a hard
    // kill mid-run would skip that). Best-effort — Ticket.requesterId has no
    // onDelete cascade, so this can fail if a prior crash also left real
    // tickets referencing this user; swallowed rather than blocking this
    // run entirely, since prisma.user.create below will still fail loudly
    // (unique constraint) if a leftover row genuinely survives this.
    await prisma.user.deleteMany({ where: { email: NOREPLY_EMAIL } }).catch(() => {});

    dept = await prisma.department.create({ data: { name: `Lifecycle Route Dept ${RUN_ID}`, slug: `lifecycle-route-dept-${RUN_ID}` } });
    openStatus = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Open ${RUN_ID}`, color: "#3b82f6", isDefault: true, isClosed: false, order: 1 } });
    closedStatus1 = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Resolved ${RUN_ID}`, color: "#22c55e", isDefault: false, isClosed: true, order: 2 } });
    closedStatus2 = await prisma.ticketStatus.create({ data: { departmentId: dept.id, name: `Archived ${RUN_ID}`, color: "#6b7280", isDefault: false, isClosed: true, order: 3 } });
    cancelReason = await prisma.ticketCancelReason.create({ data: { departmentId: dept.id, name: `Duplicate ${RUN_ID}`, isActive: true } });

    // Single ADMIN actor, logged in via credentials — ADMIN bypasses every
    // department/permission check, so this script only has to exercise the
    // notification wiring itself, not the full permission matrix (already
    // covered elsewhere in this codebase's own test suite). Also used AS
    // the requester on every ticket it creates via the API, so
    // requesterId always resolves to the no-reply address.
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    actor = await prisma.user.create({
      data: { email: NOREPLY_EMAIL, name: "Lifecycle Route Test", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, passwordHash, isActive: true },
    });
    await prisma.departmentMembership.create({
      data: { userId: actor.id, departmentId: dept.id, role: DepartmentRole.DEPARTMENT_MANAGER, source: MembershipSource.MANUAL },
    });

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await login(page, NOREPLY_EMAIL, TEST_PASSWORD);
    check("Logged in successfully", !page.url().includes("/login"));

    // ── 1. POST /api/tickets (WEB creation) ──
    console.log("\n=== WEB ticket creation (POST /api/tickets) ===\n");
    const createRes = await page.request.post(`${BASE_URL}/api/tickets`, {
      data: { title: "Route-level WEB creation test", description: "Testing the real HTTP path end to end.", departmentId: dept.id },
    });
    check("POST /api/tickets returned 201", createRes.status() === 201);
    const createdTicket = await createRes.json();
    ticketIds.push(createdTicket.id);
    await page.waitForTimeout(800); // after() runs detached from the response — give it a moment to complete
    let logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: createdTicket.id, type: "CREATED" } });
    check("Exactly one CREATED log row exists after real WEB creation", logs.length === 1);
    check("...with status SKIPPED (no-reply requester, structurally no real send possible)", logs[0]?.status === "SKIPPED");
    check("...with the expected fixed eventKey shape", logs[0]?.eventKey === `ticket:${createdTicket.id}:created`);

    // ── 2. POST /api/tickets/pending/[id]/accept (EMAIL creation) ──
    console.log("\n=== EMAIL ticket creation via pending-ticket Accept ===\n");
    const pending = await prisma.pendingTicket.create({
      data: {
        emailMessageId: `route-test-${RUN_ID}@example.com`,
        fromEmail: NOREPLY_EMAIL,
        fromName: "No Reply",
        subject: "Route-level EMAIL creation test",
        body: "<p>Body</p>",
        receivedAt: new Date(),
        departmentId: dept.id,
      },
      select: { id: true },
    });
    pendingIds.push(pending.id);
    // Before Accept: no Ticket, so no CREATED notification can exist yet.
    const beforeAcceptTicket = await prisma.ticket.findFirst({ where: { title: "Route-level EMAIL creation test" } });
    check("No real Ticket exists yet for a merely-received PendingTicket", beforeAcceptTicket === null);

    const acceptRes = await page.request.post(`${BASE_URL}/api/tickets/pending/${pending.id}/accept`, { data: {} });
    check("POST .../accept returned 200", acceptRes.status() === 200);
    const acceptedTicket = await acceptRes.json();
    ticketIds.push(acceptedTicket.id);
    await page.waitForTimeout(800);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: acceptedTicket.id, type: "CREATED" } });
    check("Exactly one CREATED log row exists only AFTER Accept", logs.length === 1);
    check("...with status SKIPPED", logs[0]?.status === "SKIPPED");

    // ── 3. PATCH /api/tickets/[id]/status (closing) ──
    console.log("\n=== Closing via PATCH /api/tickets/[id]/status ===\n");
    const statusTicket = await prisma.ticket.create({
      data: { title: "Status-route close test", description: "d", source: TicketSource.WEB, requesterId: actor.id, departmentId: dept.id, statusId: openStatus.id },
      select: { id: true },
    });
    ticketIds.push(statusTicket.id);
    const closeRes = await page.request.patch(`${BASE_URL}/api/tickets/${statusTicket.id}/status`, { data: { statusId: closedStatus1.id } });
    check("PATCH .../status returned 200", closeRes.status() === 200);
    await page.waitForTimeout(800);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: statusTicket.id, type: "CLOSED" } });
    check("Exactly one CLOSED log row after a real open->closed status change", logs.length === 1);
    check("...with status SKIPPED", logs[0]?.status === "SKIPPED");

    // Closed -> closed (a second closed status) must NOT produce a second email.
    const secondCloseRes = await page.request.patch(`${BASE_URL}/api/tickets/${statusTicket.id}/status`, { data: { statusId: closedStatus2.id } });
    check("A second PATCH .../status (closed -> closed) still returns 200", secondCloseRes.status() === 200);
    await page.waitForTimeout(800);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: statusTicket.id, type: "CLOSED" } });
    check("Still exactly one CLOSED log row after a closed->closed change", logs.length === 1);

    // ── 4. POST /api/tickets/[id]/cancel (closing) ──
    console.log("\n=== Closing via POST /api/tickets/[id]/cancel ===\n");
    const cancelTicket = await prisma.ticket.create({
      data: { title: "Cancel-route close test", description: "d", source: TicketSource.WEB, requesterId: actor.id, departmentId: dept.id, statusId: openStatus.id },
      select: { id: true },
    });
    ticketIds.push(cancelTicket.id);
    const cancelRes = await page.request.post(`${BASE_URL}/api/tickets/${cancelTicket.id}/cancel`, { data: { cancelReasonId: cancelReason.id } });
    check("POST .../cancel returned 200", cancelRes.status() === 200);
    await page.waitForTimeout(800);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: cancelTicket.id, type: "CLOSED" } });
    check("Exactly one CLOSED log row after a real cancel", logs.length === 1);
    check("...with status SKIPPED", logs[0]?.status === "SKIPPED");

    // ── 5. Generic PATCH /api/tickets/[id] closing a ticket ──
    console.log("\n=== Closing via the generic PATCH /api/tickets/[id] ===\n");
    const genericTicket = await prisma.ticket.create({
      data: { title: "Generic-route close test", description: "d", source: TicketSource.WEB, requesterId: actor.id, departmentId: dept.id, statusId: openStatus.id },
      select: { id: true },
    });
    ticketIds.push(genericTicket.id);
    const genericRes = await page.request.patch(`${BASE_URL}/api/tickets/${genericTicket.id}`, { data: { statusId: closedStatus1.id } });
    check("Generic PATCH returned 200", genericRes.status() === 200);
    await page.waitForTimeout(800);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: genericTicket.id, type: "CLOSED" } });
    check("Exactly one CLOSED log row after closing via the generic edit route", logs.length === 1);
    check("...with status SKIPPED", logs[0]?.status === "SKIPPED");

    // Re-submitting the SAME statusId via the generic route (no real change) must not add a second row.
    const genericNoopRes = await page.request.patch(`${BASE_URL}/api/tickets/${genericTicket.id}`, { data: { statusId: closedStatus1.id } });
    check("Re-submitting the same statusId still returns 200", genericNoopRes.status() === 200);
    await page.waitForTimeout(800);
    logs = await prisma.emailNotificationLog.findMany({ where: { ticketId: genericTicket.id, type: "CLOSED" } });
    check("Still exactly one CLOSED log row after resubmitting the same statusId", logs.length === 1);

    await context.close();
  } finally {
    await browser.close();
    const cleanup: [string, () => Promise<unknown>][] = [
      ["email logs", () => prisma.emailNotificationLog.deleteMany({ where: { ticketId: { in: ticketIds } } })],
      ["tickets", () => prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } })],
      ["pending tickets", () => prisma.pendingTicket.deleteMany({ where: { id: { in: pendingIds } } })],
      ["cancel reason", () => (dept ? prisma.ticketCancelReason.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["statuses", () => (dept ? prisma.ticketStatus.deleteMany({ where: { departmentId: dept.id } }) : Promise.resolve())],
      ["memberships", () => (actor ? prisma.departmentMembership.deleteMany({ where: { userId: actor.id } }) : Promise.resolve())],
      ["actor user", () => (actor ? prisma.user.deleteMany({ where: { id: actor.id } }) : Promise.resolve())],
      ["department", () => (dept ? prisma.department.deleteMany({ where: { id: dept.id } }) : Promise.resolve())],
    ];
    for (const [label, fn] of cleanup) {
      try {
        await fn();
      } catch (err) {
        console.error(`Cleanup failed for ${label}:`, err);
      }
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
