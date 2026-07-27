/**
 * Real interactive browser verification for the actual reported bug: the
 * on-page department dropdown at /admin/activity-progress ("All
 * Workspaces" mode) previously changed only a URL query param, which
 * Next.js does not remount a client component for — so
 * ActivityProgressConfigForm kept showing the PREVIOUS department's
 * percentages under the newly-selected department's label, and Saving
 * would silently overwrite the new department's real rows with the old
 * department's stale values.
 *
 * This script exercises the exact reported flow — the ON-PAGE dropdown,
 * not a deep-link URL — with IT and Finance, matching the user's own
 * example values.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-activity-progress-department-switch.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const IT_DEPT_ID = "dept-it";
const FINANCE_DEPT_ID = "dept-finance";

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
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenignAbortedPrefetch = isAborted && req.url().includes("_rsc=");
    const isBenignAbortedNotificationPoll = isAborted && req.url().includes("/api/notifications") && req.method() === "GET";
    if (!isBenignAbortedPrefetch && !isBenignAbortedNotificationPoll) {
      failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    }
  });
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

async function setTodoPercent(page: Page, value: string) {
  const input = page.locator("input[type='number']").first();
  await input.fill(value);
}

async function getTodoPercent(page: Page): Promise<string> {
  return page.locator("input[type='number']").first().inputValue();
}

async function main() {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachConsoleAndNetworkCapture(page, consoleErrors, failedRequests);

    console.log("\nLogging in and switching to 'All Workspaces' (the mode that shows the on-page department dropdown)...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", EMAIL);
    await page.fill("#credentials-password", PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    const switchToAll = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: "ALL" } });
    check("Workspace switch to 'All Workspaces' succeeded", switchToAll.ok());

    await page.goto(`${BASE_URL}/admin/activity-progress`);
    await page.waitForLoadState("networkidle");
    check("Activity Progress page renders with the on-page department picker", (await page.locator('[role="combobox"]').count()) > 0);

    // ── Step 1: select IT via the ON-PAGE dropdown, set To Do = 0% ──
    console.log("\nStep 1: select IT via the on-page dropdown, set To Do = 0%\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "IT Department" }).click();
    await page.waitForLoadState("networkidle");
    await setTodoPercent(page, "0");
    await page.click('button:has-text("Save")');
    const itSaveToast = await page.locator("text=/saved/i").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("Save succeeded for IT", itSaveToast);

    // ── Step 2: select Finance via the ON-PAGE dropdown (no full navigation) ──
    console.log("\nStep 2: select Finance via the on-page dropdown, set To Do = 10%\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "Finance" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    await setTodoPercent(page, "10");
    await page.click('button:has-text("Save")');
    const financeSaveToast = await page.locator("text=/saved/i").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("Save succeeded for Finance", financeSaveToast);

    // ── Step 3: refresh, confirm the two different values persist ──
    console.log("\nStep 3: refresh and confirm both departments kept their own distinct value\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    const financeAfterRefresh = await getTodoPercent(page);
    check("After refresh, still showing Finance (URL-synced) with its saved 10%", financeAfterRefresh === "10");

    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "IT Department" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const itAfterSwitchBack = await getTodoPercent(page);
    check("Switching back to IT shows IT's real saved 0% (not Finance's 10%, not stale)", itAfterSwitchBack === "0");

    // ── Step 4: change ONLY Finance to 15% ──
    console.log("\nStep 4: change ONLY Finance's To Do to 15%\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "Finance" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const financeBeforeEdit = await getTodoPercent(page);
    check("Finance shows its real 10% before this edit (not IT's 0%)", financeBeforeEdit === "10");
    await setTodoPercent(page, "15");
    await page.click('button:has-text("Save")');
    await page.locator("text=/saved/i").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    // ── Step 5: return to IT, confirm it's STILL 0% (the critical regression check) ──
    console.log("\nStep 5: return to IT via the dropdown — must still be 0%, proving Finance's edit never leaked into IT\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "IT Department" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const itAfterFinanceEdit = await getTodoPercent(page);
    check("IT's To Do is STILL 0% after editing Finance to 15% — the reported bug is fixed", itAfterFinanceEdit === "0");

    // Double-check via a hard reload too (not just in-page state).
    await page.reload();
    await page.waitForLoadState("networkidle");
    const itAfterHardReload = await getTodoPercent(page);
    check("IT's To Do is still 0% after a hard reload too (server-persisted, not just client state)", itAfterHardReload === "0");

    // ── Step 6: an IT activity and a Finance activity with the same status show different progress ──
    // Standalone (no projectId) — avoids depending on either department
    // having a seeded project, which isn't guaranteed (Finance has none by
    // default in this environment).
    console.log("\nStep 6: an IT activity and a Finance activity with the same status show different progress values\n");
    {
      const itActivityResp = await page.request.post(`${BASE_URL}/api/activities`, {
        data: { title: `PWCHECK IT Compare ${Date.now()}`, status: "TODO", priority: "MEDIUM", departmentId: IT_DEPT_ID },
      });
      const financeActivityResp = await page.request.post(`${BASE_URL}/api/activities`, {
        data: { title: `PWCHECK Finance Compare ${Date.now()}`, status: "TODO", priority: "MEDIUM", departmentId: FINANCE_DEPT_ID },
      });
      if (itActivityResp.ok() && financeActivityResp.ok()) {
        const itActivity = await itActivityResp.json();
        const financeActivity = await financeActivityResp.json();

        await page.goto(`${BASE_URL}/activities/${itActivity.id}`);
        await page.waitForLoadState("networkidle");
        const itActivityProgressText = await page.locator("text=/%$/").first().textContent().catch(() => null);
        check("IT activity (TODO) detail page shows a progress value", itActivityProgressText != null);

        await page.goto(`${BASE_URL}/activities/${financeActivity.id}`);
        await page.waitForLoadState("networkidle");
        const financeActivityProgressText = await page.locator("text=/%$/").first().textContent().catch(() => null);
        check("Finance activity (TODO) detail page shows a progress value", financeActivityProgressText != null);
        check(
          `IT (${itActivityProgressText}) and Finance (${financeActivityProgressText}) activities with the identical status show DIFFERENT progress — IT's 0% vs Finance's 15%`,
          itActivityProgressText !== financeActivityProgressText
        );

        await page.request.delete(`${BASE_URL}/api/activities/${itActivity.id}`);
        await page.request.delete(`${BASE_URL}/api/activities/${financeActivity.id}`);
      } else {
        check("Could create both an IT and a Finance activity to compare", false);
      }
    }

    // ── Console/network error summary ──
    console.log("\nConsole and network error summary across the whole run...\n");
    check("Zero console errors across the entire interactive session", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the entire interactive session", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
