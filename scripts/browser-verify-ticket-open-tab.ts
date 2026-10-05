/**
 * Real interactive browser verification of the new Open Tickets tab
 * (app/(main)/tickets/open/page.tsx).
 *
 * Drives the actual running dev app: click "Open Tickets" from the real
 * Tickets sidebar nav, confirm only non-closed tickets show — including
 * one whose status is "Resolved" (non-closed, deliberately NOT named
 * "Open" or anything open-sounding, proving the rule is isClosed-based,
 * never a status-name heuristic). Then switch the active Workspace via
 * the real switcher and confirm Open re-scopes. Then click "Closed
 * Tickets" (only the closed one shows) and "All Tickets" (both show).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-open-tab.ts
 * Requires a reachable DATABASE_URL and a running dev server — skips if
 * either is unavailable.
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvot-${RUN_ID}`;

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

function attachCapture(page: Page, consoleErrors: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
}

async function switchWorkspace(page: Page, departmentName: string) {
  const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
  await trigger.click();
  await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 });
  const searchInput = page.locator('input[placeholder="Search workspaces..."]');
  await searchInput.fill(departmentName);
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 5000 }).catch(() => {});
  const activeWorkspaceResponse = page.waitForResponse(
    (res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST",
    { timeout: 8000 }
  );
  await page.locator(`[role="menuitem"]:has-text("${departmentName}")`).first().click();
  await activeWorkspaceResponse.catch(() => {});
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const userIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    console.log("\n=== Fixtures: two departments, tickets covering Open/Resolved/Closed ===\n");
    const deptX = await createDepartment({ name: `${TAG}-Workspace-X`, slug: `${TAG}-workspace-x` });
    const deptY = await createDepartment({ name: `${TAG}-Workspace-Y`, slug: `${TAG}-workspace-y` });
    departmentIds.push(deptX.id, deptY.id);

    const openStatusX = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptX.id, name: "Open" } });
    const resolvedStatusX = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptX.id, name: "Resolved" } });
    const closedStatusX = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptX.id, name: "Closed" } });
    const openStatusY = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptY.id, name: "Open" } });

    const requester = await prisma.user.create({ data: { email: `${TAG}-requester@kinsen.gr`, role: "USER", authProvider: "CREDENTIALS" } });
    userIds.push(requester.id);

    const TITLE_OPEN_X = `${TAG} Open-status ticket`;
    const TITLE_RESOLVED_X = `${TAG} Resolved-status ticket (not named Open)`;
    const TITLE_CLOSED_X = `${TAG} Closed-status ticket`;
    const TITLE_OPEN_Y = `${TAG} Workspace-Y open ticket`;

    await prisma.ticket.create({ data: { title: TITLE_OPEN_X, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptX.id, statusId: openStatusX.id } });
    await prisma.ticket.create({ data: { title: TITLE_RESOLVED_X, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptX.id, statusId: resolvedStatusX.id } });
    await prisma.ticket.create({ data: { title: TITLE_CLOSED_X, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptX.id, statusId: closedStatusX.id } });
    await prisma.ticket.create({ data: { title: TITLE_OPEN_Y, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptY.id, statusId: openStatusY.id } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));
    await page.waitForTimeout(800);

    console.log(`\nSwitching to workspace "${deptX.name}"...\n`);
    await switchWorkspace(page, deptX.name);

    console.log("\n=== 1. Click 'Open Tickets' from the Tickets sidebar nav ===\n");
    await page.goto(`${BASE_URL}/tickets`);
    await page.waitForTimeout(800);
    await page.click('a[href="/tickets/open"]');
    await page.waitForURL((url) => url.pathname === "/tickets/open", { timeout: 10000 });
    await page.waitForTimeout(800);
    check("Navigated to /tickets/open via the sidebar link", page.url().includes("/tickets/open"));
    check("Heading reads 'Open Tickets'", await page.locator("h1", { hasText: "Open Tickets" }).isVisible());

    const bodyTextX = await page.locator("body").innerText();
    check("Open Tickets shows the Open-status ticket", bodyTextX.includes(TITLE_OPEN_X));
    check(
      "Open Tickets ALSO shows the Resolved-status ticket — proves the rule is isClosed-based, NOT a status-name match (its status is literally 'Resolved', not 'Open')",
      bodyTextX.includes(TITLE_RESOLVED_X)
    );
    check("Open Tickets does NOT show the Closed-status ticket", !bodyTextX.includes(TITLE_CLOSED_X));

    console.log("\n=== 2. Switch Workspace and confirm Open re-scopes ===\n");
    await switchWorkspace(page, deptY.name);
    await page.waitForURL((url) => url.pathname === "/tickets/open", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);
    const bodyTextY = await page.locator("body").innerText();
    check("After switching Workspace, Open now shows Workspace Y's open ticket", bodyTextY.includes(TITLE_OPEN_Y));
    check("...and no longer shows Workspace X's tickets", !bodyTextY.includes(TITLE_OPEN_X) && !bodyTextY.includes(TITLE_RESOLVED_X));

    console.log("\n=== 3. Click 'Closed Tickets' — only the closed ticket shows ===\n");
    await switchWorkspace(page, deptX.name);
    await page.waitForTimeout(800);
    await page.click('a[href="/tickets/closed"]');
    await page.waitForURL((url) => url.pathname === "/tickets/closed", { timeout: 10000 });
    await page.waitForTimeout(800);
    const closedBodyText = await page.locator("body").innerText();
    check("Closed Tickets shows the Closed-status ticket", closedBodyText.includes(TITLE_CLOSED_X));
    check("Closed Tickets does NOT show the Open-status ticket", !closedBodyText.includes(TITLE_OPEN_X));
    check("Closed Tickets does NOT show the Resolved-status ticket", !closedBodyText.includes(TITLE_RESOLVED_X));

    console.log("\n=== 4. Click 'All Tickets' — both categories present ===\n");
    await page.click('a[href="/tickets"]');
    await page.waitForURL((url) => url.pathname === "/tickets", { timeout: 10000 });
    await page.waitForTimeout(800);
    await page.click('button:has-text("Show all statuses")').catch(() => {});
    await page.waitForTimeout(800);
    const allBodyText = await page.locator("body").innerText();
    check("All Tickets shows the Open-status ticket", allBodyText.includes(TITLE_OPEN_X));
    check("All Tickets shows the Resolved-status ticket", allBodyText.includes(TITLE_RESOLVED_X));

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.ticket.deleteMany({ where: { title: { contains: TAG } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } });
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    await browser.close();
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
