/**
 * Real interactive browser reproduction of the reported bug: "Finance +
 * In Progress sometimes returns zero tickets even though a matching
 * Finance ticket visibly exists, and the result changes depending on the
 * sequence of workspace/filter interactions." Drives the actual running
 * dev app through the exact reported flow, repeated many times (a flaky
 * pass is not acceptable), and separately confirms the old left-most
 * "Open" status-group dropdown no longer exists.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-status-filter-race.ts
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
const TAG = `bvsr-${RUN_ID}`;

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
  // Back-to-back switches (no pause in between, as this script's transition
  // loop deliberately does to stress-test the race) can occasionally have a
  // click land while the PREVIOUS switch's re-render is still settling —
  // the dropdown trigger's own click handler briefly no-ops mid-render.
  // Retrying the click (checking data-state, not just "did the click not
  // throw") makes the test robust to that UI-level timing quirk without
  // masking the thing actually under test (the SERVER-side filter/query
  // correctness, asserted after the switch completes).
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    const found = await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 2000 }).catch(() => null);
    if (found) break;
    if (attempt === 2) {
      throw new Error(`switchWorkspace: dropdown never opened for "${departmentName}" after 3 attempts`);
    }
    await page.waitForTimeout(300);
  }
  // "All Workspaces" is a PINNED item, only rendered while the search box is
  // empty (it's hidden the moment a search is active) — never type it into
  // the search input, or it hides itself and the click target never appears.
  const isAllWorkspaces = departmentName === "All Workspaces";
  if (!isAllWorkspaces) {
    const searchInput = page.locator('input[placeholder="Search workspaces..."]');
    await searchInput.fill(departmentName);
    await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 5000 }).catch(() => {});
  }
  // .catch() attached at creation (not after the click) — if the click
  // below throws (e.g. the target never appeared), this promise must still
  // never reject unhandled; awaiting a separately-caught reference later
  // would leave THIS original promise's own rejection unhandled once the
  // click throws before reaching that later await.
  const activeWorkspaceResponse = page
    .waitForResponse((res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST", { timeout: 8000 })
    .catch(() => null);
  await page.locator(`[role="menuitem"]:has-text("${departmentName}")`).first().click();
  await activeWorkspaceResponse;
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

/** Status is now the FIRST combobox (Sort by aside) — the old left-most group dropdown was removed. */
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
    console.log("\n=== Fixtures: Finance + another workspace, Finance has an In Progress ticket ===\n");
    const finance = await createDepartment({ name: `${TAG}-Finance`, slug: `${TAG}-finance` });
    const other = await createDepartment({ name: `${TAG}-Other`, slug: `${TAG}-other` });
    departmentIds.push(finance.id, other.id);

    await prisma.ticketStatus.deleteMany({ where: { departmentId: { in: [finance.id, other.id] } } });

    const financeOpen = await prisma.ticketStatus.create({ data: { name: `${TAG}Open`, color: "#3b82f6", isClosed: false, isDefault: true, order: 1, departmentId: finance.id } });
    const financeInProgress = await prisma.ticketStatus.create({ data: { name: `${TAG}InProgress`, color: "#f59e0b", isClosed: false, order: 2, departmentId: finance.id } });
    await prisma.ticketStatus.create({ data: { name: `${TAG}OtherOpen`, color: "#3b82f6", isClosed: false, isDefault: true, order: 1, departmentId: other.id } });
    const otherInProgress = await prisma.ticketStatus.create({ data: { name: `${TAG}InProgress`, color: "#f59e0b", isClosed: false, order: 2, departmentId: other.id } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });

    const ticketA = await prisma.ticket.create({
      data: { title: `${TAG} Finance In-Progress Ticket`, description: "fixture", departmentId: finance.id, statusId: financeInProgress.id, requesterId: admin.id },
    });
    const ticketB = await prisma.ticket.create({
      data: { title: `${TAG} Finance Open Ticket`, description: "fixture", departmentId: finance.id, statusId: financeOpen.id, requesterId: admin.id },
    });
    const ticketC = await prisma.ticket.create({
      data: { title: `${TAG} Other In-Progress Ticket`, description: "fixture", departmentId: other.id, statusId: otherInProgress.id, requesterId: admin.id },
    });
    ticketIds.push(ticketA.id, ticketB.id, ticketC.id);

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

    console.log("\nAsserting the old left-most 'Open' status-group dropdown no longer exists...\n");
    await switchWorkspace(page, finance.name);
    await page.goto(`${BASE_URL}/tickets`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      (window as any).__noReloadMarker = true;
    });
    check('No dropdown trigger shows the bare text "Open" (the removed status-group selector)', (await page.locator('button[role="combobox"]', { hasText: /^Open$/ }).count()) === 0);
    const firstComboboxText = await page.locator('button[role="combobox"]').nth(STATUS_INDEX).innerText();
    check('The first real filter combobox is Status (shows "All statuses" by default, not "Open")', firstComboboxText.includes("All statuses"));

    console.log("\nCore reproduction: Finance visibly shows the In Progress ticket by default...\n");
    check("Finance default view shows the In Progress ticket", (await page.locator(`text=${ticketA.title}`).count()) > 0);
    check("Finance default view shows the Open ticket", (await page.locator(`text=${ticketB.title}`).count()) > 0);

    console.log("\nSelecting 'In Progress' from the Status filter — repeated 6 times — must ALWAYS show the matching ticket...\n");
    let allSelectionsCorrect = true;
    for (let i = 0; i < 6; i++) {
      await selectStatus(page, financeInProgress.name);
      await page.waitForFunction(
        (title) => !document.body.innerText.includes(title),
        ticketB.title,
        { timeout: 8000 }
      ).catch(() => {});
      const hasA = (await page.locator(`text=${ticketA.title}`).count()) > 0;
      const hasB = (await page.locator(`text=${ticketB.title}`).count()) > 0;
      if (!hasA || hasB) {
        allSelectionsCorrect = false;
        console.error(`   [iteration ${i}] In Progress ticket visible: ${hasA}, Open ticket visible: ${hasB}`);
      }
      await clearStatus(page);
      await page.waitForFunction(
        (title) => document.body.innerText.includes(title),
        ticketB.title,
        { timeout: 8000 }
      ).catch(() => {});
    }
    check("All 6 repeated 'In Progress' selections correctly showed only the In Progress ticket — never zero results", allSelectionsCorrect);

    console.log("\nWorkspace transitions: Other -> Finance -> select In Progress, repeated 4 times...\n");
    let allTransitionsCorrect = true;
    let allTransitionsReloadFree = true;
    for (let i = 0; i < 4; i++) {
      await switchWorkspace(page, other.name);
      await switchWorkspace(page, finance.name);
      await selectStatus(page, financeInProgress.name);
      await page.waitForFunction(
        (title) => !document.body.innerText.includes(title),
        ticketB.title,
        { timeout: 8000 }
      ).catch(() => {});
      const hasA = (await page.locator(`text=${ticketA.title}`).count()) > 0;
      if (!hasA) {
        allTransitionsCorrect = false;
        console.error(`   [transition ${i}] In Progress ticket visible: ${hasA}`);
      }
      // Checked HERE, before the page.goto() reset below — that goto is a
      // deliberate real navigation this test uses to reset the URL between
      // iterations, not part of what's under test, and would trivially
      // clear the marker if checked afterward.
      if (!(await page.evaluate(() => (window as any).__noReloadMarker === true))) {
        allTransitionsReloadFree = false;
        console.error(`   [transition ${i}] noReloadMarker was cleared — an unexpected full reload occurred`);
      }
      await page.goto(`${BASE_URL}/tickets`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => {
        (window as any).__noReloadMarker = true;
      });
    }
    check("All 4 repeated Other -> Finance -> In Progress transitions correctly showed the matching ticket", allTransitionsCorrect);
    check("No full page reload occurred during any workspace switch or status selection (client-side navigation only)", allTransitionsReloadFree);

    console.log("\nAll Workspaces -> Finance -> In Progress...\n");
    await switchWorkspace(page, "All Workspaces");
    await switchWorkspace(page, finance.name);
    await selectStatus(page, financeInProgress.name);
    await page.waitForFunction(
      (title) => !document.body.innerText.includes(title),
      ticketB.title,
      { timeout: 8000 }
    ).catch(() => {});
    check("All Workspaces -> Finance -> In Progress shows the matching ticket", (await page.locator(`text=${ticketA.title}`).count()) > 0);

    console.log("\nFinance -> In Progress -> All Workspaces (selection reconciles rather than silently emptying)...\n");
    await switchWorkspace(page, "All Workspaces");
    await page.waitForLoadState("networkidle");
    check("Switching to All Workspaces while In Progress was selected does not crash/blank the page", (await page.locator('button[role="combobox"]').count()) > 0);

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
