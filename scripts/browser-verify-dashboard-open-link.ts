/**
 * Real interactive browser verification that the Dashboard's "Open" KPI
 * card now navigates directly to the canonical /tickets/open route
 * (components/dashboard/kpi-cards.tsx), instead of the old indirect
 * /tickets?status=open.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-dashboard-open-link.ts
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
const TAG = `bvdol-${RUN_ID}`;

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
    console.log("\n=== Fixtures: one department with an Open ticket and a Closed ticket ===\n");
    const dept = await createDepartment({ name: `${TAG}-Workspace`, slug: `${TAG}-workspace` });
    departmentIds.push(dept.id);

    const openStatus = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Open" } });
    const closedStatus = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: dept.id, name: "Closed" } });
    const requester = await prisma.user.create({ data: { email: `${TAG}-requester@kinsen.gr`, role: "USER", authProvider: "CREDENTIALS" } });
    userIds.push(requester.id);

    const TITLE_OPEN = `${TAG} Open ticket`;
    const TITLE_CLOSED = `${TAG} Closed ticket`;
    await prisma.ticket.create({ data: { title: TITLE_OPEN, description: "seed", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: openStatus.id } });
    await prisma.ticket.create({ data: { title: TITLE_CLOSED, description: "seed", source: "WEB", requesterId: requester.id, departmentId: dept.id, statusId: closedStatus.id } });

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

    console.log(`\nSwitching to workspace "${dept.name}"...\n`);
    await switchWorkspace(page, dept.name);

    console.log("\n=== 1-2. Open Dashboard, click the Open Tickets KPI card ===\n");
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForTimeout(800);
    const closedCardHrefBefore = await page.locator('a[aria-label="View closed tickets"]').getAttribute("href");
    const allCardHrefBefore = await page.locator('a[aria-label="View all tickets"]').getAttribute("href");

    await page.click('a[aria-label="View open tickets"]');
    await page.waitForURL((url) => url.pathname === "/tickets/open", { timeout: 10000 });
    await page.waitForTimeout(800);

    console.log("\n=== 3. Confirm URL is /tickets/open ===\n");
    check("URL after clicking the Open KPI card is exactly /tickets/open", page.url().endsWith("/tickets/open"));

    console.log("\n=== 4-5. Confirm the Open Tickets page renders with the correct workspace-scoped rows ===\n");
    check("Heading reads 'Open Tickets'", await page.locator("h1", { hasText: "Open Tickets" }).isVisible());
    const bodyText = await page.locator("body").innerText();
    check("The Open ticket is shown", bodyText.includes(TITLE_OPEN));
    check("The Closed ticket is NOT shown", !bodyText.includes(TITLE_CLOSED));

    console.log("\n=== 6. Navigate back to Dashboard, confirm other cards are unchanged ===\n");
    await page.goBack();
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 10000 });
    await page.waitForTimeout(800);
    const closedCardHrefAfter = await page.locator('a[aria-label="View closed tickets"]').getAttribute("href");
    const allCardHrefAfter = await page.locator('a[aria-label="View all tickets"]').getAttribute("href");
    check("Closed Tickets card href is unchanged", closedCardHrefAfter === closedCardHrefBefore, `before=${closedCardHrefBefore} after=${closedCardHrefAfter}`);
    check("All Tickets card href is unchanged", allCardHrefAfter === allCardHrefBefore, `before=${allCardHrefBefore} after=${allCardHrefAfter}`);

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
