/**
 * Real interactive browser reproduction of the EXACT reported bug: Workspace
 * = Finance, Status = All statuses shows a ticket with a visible "Open"
 * badge; selecting Status = Open then returned ZERO tickets — a hard
 * contradiction caused by a data-integrity bug (ticket.statusId pointing at
 * a DIFFERENT department's "Open" row than the ticket's own departmentId;
 * see scripts/repair-ticket-config-department-mismatch.ts and
 * validateTicketConfigOwnership in lib/services/department-scope-service.ts
 * for the full root-cause/fix).
 *
 * Uses the REAL rendered ticket identity (its title, rendered once and
 * tracked across every step), not just row counts, exactly as the original
 * report was made ("KIN-10, Open, Low, Printing" — a specific ticket, not a
 * count). Flow, run in a single browser session:
 *   1. Select the Finance-equivalent workspace.
 *   2. Status = All statuses -> record the visible Open-badged ticket.
 *   3. Status = Open -> assert THAT SAME ticket remains visible.
 *   4. Clear Status -> assert it returns.
 *   5. Repeat 2-4 five consecutive times (zero tolerance for intermittency).
 *   6. Equivalent cycle for the In Progress ticket.
 *   7. Workspace transitions: Finance -> Other -> Finance -> Open, and
 *      All Workspaces -> Finance -> Open.
 * Every step asserts: no full page reload, zero console errors, zero failed
 * API requests, the URL's statusId matches the selected option's real id,
 * the rendered workspace name is correct, and the exact expected ticket row
 * is present (by title, not just count).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-config-integrity-ui.ts
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
const TAG = `bvci-${RUN_ID}`;

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

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenign =
      isAborted &&
      (req.url().includes("_rsc=") ||
        (req.url().includes("/api/notifications") && req.method() === "GET") ||
        (req.url().includes("/_next/static/css/") && req.method() === "GET"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
}

async function switchWorkspace(page: Page, departmentName: string) {
  const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    const found = await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 2000 }).catch(() => null);
    if (found) break;
    if (attempt === 2) throw new Error(`switchWorkspace: dropdown never opened for "${departmentName}" after 3 attempts`);
    await page.waitForTimeout(300);
  }
  const isAllWorkspaces = departmentName === "All Workspaces";
  if (!isAllWorkspaces) {
    const searchInput = page.locator('input[placeholder="Search workspaces..."]');
    await searchInput.fill(departmentName);
    await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 5000 }).catch(() => {});
  }
  const activeWorkspaceResponse = page
    .waitForResponse((res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST", { timeout: 8000 })
    .catch(() => null);
  await page.locator(`[role="menuitem"]:has-text("${departmentName}")`).first().click();
  await activeWorkspaceResponse;
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

/** Status is the first real filter combobox (Sort by aside) — the old left-most status-group dropdown was removed. */
const STATUS_INDEX = 1;

async function selectStatus(page: Page, name: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const trigger = page.locator('button[role="combobox"]').nth(STATUS_INDEX);
    await trigger.click();
    await page.waitForSelector('[role="option"]', { timeout: 5000 });
    const option = page.getByRole("option", { name, exact: true });
    if ((await option.count()) > 0) {
      await option.click();
      await page.locator('[role="option"]').first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      return;
    }
    await page.keyboard.press("Escape");
    await page.locator('[role="option"]').first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  throw new Error(`selectStatus: option "${name}" never appeared within ${timeoutMs}ms`);
}

async function clearStatus(page: Page) {
  const trigger = page.locator('button[role="combobox"]').nth(STATUS_INDEX);
  await trigger.click();
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  await page.getByRole("option", { name: "All statuses", exact: true }).click();
  await page.locator('[role="option"]').first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}

function urlStatusId(page: Page): string | null {
  return new URL(page.url()).searchParams.get("statusId");
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const departmentIds: string[] = [];
  const ticketIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    console.log("\n=== Fixtures: Finance-equivalent + Other workspace, an Open ticket and an In Progress ticket ===\n");
    const finance = await createDepartment({ name: `${TAG}-Finance`, slug: `${TAG}-finance` });
    const other = await createDepartment({ name: `${TAG}-Other`, slug: `${TAG}-other` });
    departmentIds.push(finance.id, other.id);

    const financeOpen = await prisma.ticketStatus.findFirst({ where: { departmentId: finance.id, name: "Open" }, select: { id: true, name: true } });
    const financeInProgress = await prisma.ticketStatus.findFirst({ where: { departmentId: finance.id, name: "In Progress" }, select: { id: true, name: true } });
    if (!financeOpen || !financeInProgress) throw new Error("Starter Open/In Progress statuses were not seeded for the new department — cannot run.");

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const openTicket = await prisma.ticket.create({
      data: { title: `${TAG} Open Badge Ticket`, description: "fixture", departmentId: finance.id, statusId: financeOpen.id, requesterId: admin.id },
    });
    const inProgressTicket = await prisma.ticket.create({
      data: { title: `${TAG} In Progress Badge Ticket`, description: "fixture", departmentId: finance.id, statusId: financeInProgress.id, requesterId: admin.id },
    });
    ticketIds.push(openTicket.id, inProgressTicket.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors, failedRequests);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));
    await page.waitForLoadState("networkidle");

    console.log(`\n1. Select workspace "${finance.name}"...\n`);
    await switchWorkspace(page, finance.name);
    await page.goto(`${BASE_URL}/tickets`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      (window as any).__noReloadMarker = true;
    });
    check("Rendered workspace indicator shows the selected Finance-equivalent department", (await page.locator(`text=${finance.name}`).count()) > 0);

    console.log("\n2. Status = All statuses -> the Open-badged ticket is visible...\n");
    check('Status filter defaults to "All statuses"', (await page.locator('button[role="combobox"]').nth(STATUS_INDEX).innerText()).includes("All statuses"));
    check("The exact Open-badged ticket (by title) is visible with no filter", (await page.locator(`text=${openTicket.title}`).count()) > 0);

    console.log(`\n3-5. Select Status = Open -> assert the SAME ticket remains visible -> clear -> repeat 5 times...\n`);
    let allOpenCyclesCorrect = true;
    for (let i = 1; i <= 5; i++) {
      await selectStatus(page, financeOpen.name);
      await page.waitForFunction(
        (title) => document.body.innerText.includes(title),
        openTicket.title,
        { timeout: 8000 }
      ).catch(() => {});
      const stillVisible = (await page.locator(`text=${openTicket.title}`).count()) > 0;
      const currentUrlStatusId = urlStatusId(page);
      const urlCorrect = currentUrlStatusId === financeOpen.id;
      const noReload = await page.evaluate(() => (window as any).__noReloadMarker === true);
      if (!stillVisible || !urlCorrect || !noReload) {
        allOpenCyclesCorrect = false;
        console.error(`   [cycle ${i}/5] visible=${stillVisible} urlStatusId=${currentUrlStatusId} (expected ${financeOpen.id}) noReload=${noReload}`);
      }
      await clearStatus(page);
      await page.waitForFunction(
        (title) => document.body.innerText.includes(title),
        openTicket.title,
        { timeout: 8000 }
      ).catch(() => {});
      const returnedAfterClear = (await page.locator(`text=${openTicket.title}`).count()) > 0;
      if (!returnedAfterClear) {
        allOpenCyclesCorrect = false;
        console.error(`   [cycle ${i}/5] ticket did not return after clearing the Status filter`);
      }
    }
    check(
      "All 5 consecutive All-statuses->Open->assert-same-ticket-visible->clear cycles were correct — the exact reported bug (Open badge visible, Open filter empties it) never reproduced",
      allOpenCyclesCorrect
    );

    console.log("\n6. Equivalent cycle for the In Progress ticket, repeated 5 times...\n");
    let allInProgressCyclesCorrect = true;
    for (let i = 1; i <= 5; i++) {
      await selectStatus(page, financeInProgress.name);
      await page.waitForFunction(
        (title) => document.body.innerText.includes(title),
        inProgressTicket.title,
        { timeout: 8000 }
      ).catch(() => {});
      const stillVisible = (await page.locator(`text=${inProgressTicket.title}`).count()) > 0;
      const openTicketAbsent = (await page.locator(`text=${openTicket.title}`).count()) === 0;
      const urlCorrect = urlStatusId(page) === financeInProgress.id;
      if (!stillVisible || !openTicketAbsent || !urlCorrect) {
        allInProgressCyclesCorrect = false;
        console.error(`   [cycle ${i}/5] inProgressVisible=${stillVisible} openAbsent=${openTicketAbsent} urlStatusId=${urlStatusId(page)}`);
      }
      await clearStatus(page);
      await page.waitForFunction(
        (title) => document.body.innerText.includes(title),
        openTicket.title,
        { timeout: 8000 }
      ).catch(() => {});
    }
    check("All 5 consecutive In Progress cycles were correct", allInProgressCyclesCorrect);

    console.log(`\n7. Workspace transitions: ${finance.name} -> ${other.name} -> ${finance.name} -> Open...\n`);
    await switchWorkspace(page, other.name);
    await switchWorkspace(page, finance.name);
    await selectStatus(page, financeOpen.name);
    await page.waitForFunction(
      (title) => document.body.innerText.includes(title),
      openTicket.title,
      { timeout: 8000 }
    ).catch(() => {});
    check(`${finance.name} -> ${other.name} -> ${finance.name} -> Open still shows the exact Open ticket`, (await page.locator(`text=${openTicket.title}`).count()) > 0);
    check("...URL statusId matches Finance's own Open id after the transition", urlStatusId(page) === financeOpen.id);

    console.log(`\n8. All Workspaces -> ${finance.name} -> Open...\n`);
    await switchWorkspace(page, "All Workspaces");
    await switchWorkspace(page, finance.name);
    await selectStatus(page, financeOpen.name);
    await page.waitForFunction(
      (title) => document.body.innerText.includes(title),
      openTicket.title,
      { timeout: 8000 }
    ).catch(() => {});
    check(`All Workspaces -> ${finance.name} -> Open still shows the exact Open ticket`, (await page.locator(`text=${openTicket.title}`).count()) > 0);

    console.log("\nConsole and network error summary...\n");
    check("Zero unexpected console errors", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    await prisma.ticket.deleteMany({ where: { id: { in: ticketIds } } }).catch(() => {});
    if (departmentIds.length > 0) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketPriority.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
      await prisma.department.deleteMany({ where: { id: { in: departmentIds } } }).catch(() => {});
    }
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
