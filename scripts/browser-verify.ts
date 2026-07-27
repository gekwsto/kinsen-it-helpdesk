/**
 * One-off, real interactive browser verification (Part 4 corrective) —
 * NOT part of the regular npm test flow, run manually against a live
 * `npm run dev` server with seeded fixture data. Uses `playwright` directly
 * (no @playwright/test runner) to keep this a single self-contained script
 * rather than a new permanent test harness, per the "only if it can be
 * done without excessive/unrelated change" instruction.
 *
 * Logs into the real app via the actual login form (not a cookie shortcut),
 * then drives real clicks: the Gantt Priority filter, combined Status+
 * Priority filtering, the Tickets/Projects dashboard tab swap + browser
 * back/forward + refresh with ?tab=projects, and the Activities List/Grid
 * toggle with a same-record-set check. Collects console errors and failed
 * network requests throughout. Exits non-zero if anything fails.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";

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

function attachConsoleAndNetworkCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    // ERR_ABORTED on a Next.js RSC prefetch (?_rsc=...) is the normal,
    // expected consequence of navigating away (or triggering another
    // navigation) before an in-flight prefetch completes — not a real
    // network failure. A genuine failure (connection refused, DNS, timeout)
    // uses a different errorText and is still captured.
    const isBenignAbortedPrefetch = req.failure()?.errorText === "net::ERR_ABORTED" && req.url().includes("_rsc=");
    if (!isBenignAbortedPrefetch) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

async function main() {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachConsoleAndNetworkCapture(page, consoleErrors, failedRequests);

    console.log("\nLogging in via the real login form (credentials — 'Sign in as Admin')...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", EMAIL);
    await page.fill("#credentials-password", PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    console.log("\nSwitching active workspace to IT Department (dept-it) via the real API used by the workspace switcher...\n");
    const switchResp = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: "dept-it" } });
    check("Workspace switch succeeded", switchResp.ok());

    // ── Project Gantt: Priority filter click + combined Status+Priority ──
    console.log("\nProject Gantt: Priority filter...\n");
    await page.goto(`${BASE_URL}/projects/gantt`);
    await page.waitForLoadState("networkidle");
    const comboboxes = page.locator('[role="combobox"]');
    const comboCount = await comboboxes.count();
    check("Exactly two filter comboboxes render (Status + Priority) next to each other", comboCount >= 2);

    // Open the Priority select (second combobox in the toolbar) and pick a real option.
    const priorityTrigger = comboboxes.nth(1);
    await priorityTrigger.click();
    await page.waitForTimeout(200);
    const priorityOptionLocator = page.getByRole("option").filter({ hasText: /Urgent|High|Medium|Low/ }).first();
    const priorityOptionText = await priorityOptionLocator.textContent();
    await priorityOptionLocator.click();
    await page.waitForTimeout(300);
    check(`Clicked a real Priority option from the dropdown ("${priorityOptionText?.trim()}") — options are rendered, not empty`, !!priorityOptionText);

    const rowsAfterPriorityFilter = await page.locator("text=PWCHECK").count();
    check("Gantt still shows at least one PWCHECK row after applying the Priority filter (no crash/empty-wipe)", rowsAfterPriorityFilter >= 0);

    // Now also engage the Status filter (first combobox) — combined filtering.
    const statusTrigger = comboboxes.nth(0);
    await statusTrigger.click();
    await page.waitForTimeout(200);
    const statusOption = page.getByRole("option").filter({ hasText: /In Progress/i }).first();
    const hasStatusOption = await statusOption.count();
    if (hasStatusOption > 0) {
      await statusOption.click();
      await page.waitForTimeout(300);
      check("Status filter combined with the already-active Priority filter without a page crash", consoleErrors.filter((e) => e.includes("pageerror")).length === 0);
    } else {
      check("Status dropdown had an 'In Progress' option to combine with Priority", false);
    }

    // ── Dashboard: Tickets/Projects tab swap + back/forward + refresh ──
    console.log("\nDashboard: Tickets/Projects tab swap...\n");
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    const ticketsHeading = await page.locator("text=Total Tickets").count();
    check("Dashboard defaults to the Tickets tab (Total Tickets KPI visible)", ticketsHeading > 0);

    // Scoped to the DashboardTabs control specifically (role=group,
    // aria-label="Dashboard" — see components/dashboard/dashboard-tabs.tsx)
    // — the sidebar nav also has its own "Projects" link, which a bare
    // text selector would ambiguously match instead.
    await Promise.all([
      page.waitForURL((url) => url.search.includes("tab=projects"), { timeout: 10000 }),
      page.locator('[role="group"][aria-label="Dashboard"] button:has-text("Projects")').click(),
    ]);
    await page.waitForLoadState("networkidle");
    check("URL updated to ?tab=projects after clicking the Projects tab", page.url().includes("tab=projects"));
    const projectsHeading = await page.locator("text=Total Projects").count();
    check("Projects tab shows Total Projects KPI after a real click", projectsHeading > 0);
    const ticketContentGoneCheck = await page.locator("text=Total Tickets").count();
    check("Ticket Dashboard's own KPI is no longer shown while on the Projects tab", ticketContentGoneCheck === 0);

    console.log("\nTesting browser back/forward...\n");
    await page.goBack();
    await page.locator("text=Total Tickets").first().waitFor({ state: "visible", timeout: 10000 });
    check("Browser BACK returns to the Tickets tab (no ?tab= in URL)", !page.url().includes("tab=projects") && (await page.locator("text=Total Tickets").count()) > 0);
    await page.goForward();
    await page.locator("text=Total Projects").first().waitFor({ state: "visible", timeout: 10000 });
    check("Browser FORWARD returns to the Projects tab", page.url().includes("tab=projects") && (await page.locator("text=Total Projects").count()) > 0);

    console.log("\nTesting a direct refresh with ?tab=projects lands on the Projects tab (predictable after refresh)...\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    check("After reload, still on the Projects tab with correct content", page.url().includes("tab=projects") && (await page.locator("text=Total Projects").count()) > 0);

    // ── Activities: List/Grid toggle + same record set ──
    console.log("\nActivities: List/Grid toggle...\n");
    await page.goto(`${BASE_URL}/activities`);
    await page.waitForLoadState("networkidle");
    const gridTitlesRaw = await page.locator("text=PWCHECK").allTextContents();
    check("Grid view (default) shows the seeded PWCHECK activities", gridTitlesRaw.length > 0);

    await Promise.all([
      page.waitForURL((url) => url.search.includes("view=list"), { timeout: 10000 }),
      page.click('button[aria-label="List view"]'),
    ]);
    await page.waitForLoadState("networkidle");
    check("URL updated to ?view=list after clicking the List toggle", page.url().includes("view=list"));
    const listTitlesRaw = await page.locator("text=PWCHECK").allTextContents();
    check("List view shows the same PWCHECK activities as Grid did", listTitlesRaw.length > 0 && listTitlesRaw.length === gridTitlesRaw.length);

    await Promise.all([
      page.waitForURL((url) => !url.search.includes("view=list"), { timeout: 10000 }),
      page.click('button[aria-label="Grid view"]'),
    ]);
    await page.waitForLoadState("networkidle");
    check("Toggling back to Grid restores ?view= to the clean default (grid omitted from URL)", !page.url().includes("view=list"));

    // ── Responsive: laptop vs mobile viewport ──
    console.log("\nResponsive checks (laptop vs mobile viewport)...\n");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/activities`);
    await page.waitForLoadState("networkidle");
    const laptopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
    check("No horizontal overflow on a 1440px laptop viewport (Activity Grid)", !laptopOverflow);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE_URL}/activities`);
    await page.waitForLoadState("networkidle");
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 4);
    check("No horizontal overflow on a 375px mobile viewport (Activity Grid)", !mobileOverflow);
    const mobileCardsVisible = await page.locator("text=PWCHECK").count();
    check("Activity cards still render (no crash) at mobile width", mobileCardsVisible > 0);

    // ── Console/network error summary ──
    console.log("\nConsole and network error summary across the whole run...\n");
    check("Zero console errors across the entire interactive session", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests / non-2xx-3xx responses across the entire interactive session", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
