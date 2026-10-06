/**
 * Real interactive browser verification of the new "Department" column on
 * the shared Ticket list table — appears immediately before "Dept. changed
 * by" on /tickets, /tickets/open, /tickets/closed, shows each row's own
 * real current department (not the active Workspace), and survives a
 * Workspace switch with correct per-row values and no layout breakage.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-table-department-column.ts
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
const TAG = `bvtdc-${RUN_ID}`;

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
  // "All Workspaces" is a fixed/pinned entry above the search-filtered
  // department list — typing it into the search box filters it OUT rather
  // than finding it, so it's selected directly, unfiltered.
  if (departmentName !== "All Workspaces") {
    await page.fill('input[placeholder="Search workspaces..."]', departmentName);
    await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 5000 }).catch(() => {});
  }
  // .catch() chained IMMEDIATELY at creation (same synchronous tick) —
  // attaching it only after the later `await click()` leaves a window
  // where Node can flag this as an unhandled rejection and crash the
  // process, even though it's logically "caught" a few lines down.
  const activeWorkspaceResponse = page
    .waitForResponse((res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST", { timeout: 8000 })
    .catch(() => null);
  await page.locator(`[role="menuitem"]:has-text("${departmentName}")`).first().click();
  await activeWorkspaceResponse;
  await page.waitForTimeout(800);
}

async function checkColumnOrderAndValues(page: Page, url: string, label: string, expectedTitlesToDept: Record<string, string>) {
  await page.goto(url);
  await page.waitForTimeout(800);

  const headers = await page.locator("table thead th").allTextContents();
  const deptIdx = headers.findIndex((h) => h.trim() === "Department");
  const changedByIdx = headers.findIndex((h) => h.trim() === "Dept. changed by");
  check(`[${label}] 'Department' header exists`, deptIdx !== -1, `headers: ${headers.join(" | ")}`);
  check(`[${label}] 'Department' appears immediately before 'Dept. changed by'`, deptIdx !== -1 && changedByIdx !== -1 && deptIdx === changedByIdx - 1, `headers: ${headers.join(" | ")}`);

  for (const [title, deptName] of Object.entries(expectedTitlesToDept)) {
    const row = page.locator("table tbody tr", { hasText: title }).first();
    const rowVisible = await row.isVisible().catch(() => false);
    if (!rowVisible) {
      check(`[${label}] Row for "${title}" is visible`, false);
      continue;
    }
    const cells = await row.locator("td").allTextContents();
    const cellValue = deptIdx !== -1 ? cells[deptIdx]?.trim() : undefined;
    check(`[${label}] Row "${title}" shows its real Department ("${deptName}")`, cellValue === deptName, `got: "${cellValue}"`);
  }

  // No page-level horizontal overflow outside the table's own scroll container.
  const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  check(`[${label}] No unintended page-level horizontal overflow`, bodyScrollWidth <= viewportWidth + 20, `body=${bodyScrollWidth} viewport=${viewportWidth}`);
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
    console.log("\n=== Fixtures: two departments, Open and Closed tickets in each ===\n");
    const deptX = await createDepartment({ name: `${TAG}-Finance`, slug: `${TAG}-finance` });
    const deptY = await createDepartment({ name: `${TAG}-IT`, slug: `${TAG}-it` });
    departmentIds.push(deptX.id, deptY.id);

    const openStatusX = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptX.id, name: "Open" } });
    const closedStatusX = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptX.id, name: "Closed" } });
    const openStatusY = await prisma.ticketStatus.findFirstOrThrow({ where: { departmentId: deptY.id, name: "Open" } });

    const requester = await prisma.user.create({ data: { email: `${TAG}-requester@kinsen.gr`, role: "USER", authProvider: "CREDENTIALS" } });
    userIds.push(requester.id);

    const TITLE_OPEN_X = `${TAG} Open X`;
    const TITLE_CLOSED_X = `${TAG} Closed X`;
    const TITLE_OPEN_Y = `${TAG} Open Y`;

    await prisma.ticket.create({ data: { title: TITLE_OPEN_X, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptX.id, statusId: openStatusX.id } });
    await prisma.ticket.create({ data: { title: TITLE_CLOSED_X, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptX.id, statusId: closedStatusX.id } });
    await prisma.ticket.create({ data: { title: TITLE_OPEN_Y, description: "seed", source: "WEB", requesterId: requester.id, departmentId: deptY.id, statusId: openStatusY.id } });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.waitForSelector("#credentials-email", { state: "visible" });
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    console.log("\n=== A. /tickets (All Tickets, All Workspaces) ===\n");
    await switchWorkspace(page, "All Workspaces");
    await checkColumnOrderAndValues(page, `${BASE_URL}/tickets?status=all`, "All Tickets", {
      [TITLE_OPEN_X]: deptX.name,
      [TITLE_CLOSED_X]: deptX.name,
      [TITLE_OPEN_Y]: deptY.name,
    });

    console.log("\n=== B. /tickets/open ===\n");
    await checkColumnOrderAndValues(page, `${BASE_URL}/tickets/open`, "Open Tickets", {
      [TITLE_OPEN_X]: deptX.name,
      [TITLE_OPEN_Y]: deptY.name,
    });

    console.log("\n=== C. /tickets/closed ===\n");
    await checkColumnOrderAndValues(page, `${BASE_URL}/tickets/closed`, "Closed Tickets", {
      [TITLE_CLOSED_X]: deptX.name,
    });

    console.log("\n=== Switch Workspace to Finance only — scope + Department values still correct ===\n");
    await switchWorkspace(page, deptX.name);
    await page.goto(`${BASE_URL}/tickets?status=all`);
    await page.waitForTimeout(800);
    const bodyText = await page.locator("body").innerText();
    check("After switching to Finance workspace, Finance's own tickets are shown", bodyText.includes(TITLE_OPEN_X) && bodyText.includes(TITLE_CLOSED_X));
    check("...and IT's ticket is correctly scoped OUT", !bodyText.includes(TITLE_OPEN_Y));
    const rowAfterSwitch = page.locator("table tbody tr", { hasText: TITLE_OPEN_X }).first();
    const headersAfterSwitch = await page.locator("table thead th").allTextContents();
    const deptIdxAfterSwitch = headersAfterSwitch.findIndex((h) => h.trim() === "Department");
    const cellsAfterSwitch = await rowAfterSwitch.locator("td").allTextContents();
    check("...and its Department cell still correctly shows 'Finance' (not the workspace selector's own label coincidentally matching)", cellsAfterSwitch[deptIdxAfterSwitch]?.trim() === deptX.name);

    console.log("\n=== Existing row actions still work ===\n");
    const viewRow = page.locator("table tbody tr", { hasText: TITLE_OPEN_X }).first();
    await viewRow.scrollIntoViewIfNeeded();
    const viewButton = viewRow.getByRole("link", { name: "View" });
    let navigatedToDetail = false;
    try {
      await Promise.all([page.waitForURL(/\/tickets\/[a-z0-9]+$/i, { timeout: 8000 }), viewButton.click()]);
      navigatedToDetail = true;
    } catch (err) {
      console.error("View navigation did not complete:", err instanceof Error ? err.message : String(err));
    }
    check("Clicking 'View' on a row still navigates to the Ticket detail page", navigatedToDetail, `url: ${page.url()}`);

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
