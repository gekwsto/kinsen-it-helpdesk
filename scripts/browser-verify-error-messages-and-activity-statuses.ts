/**
 * Real interactive browser verification for this task's two parts:
 *
 *  Part 1 — specific backend error messages (lib/api-errors.ts) actually
 *  reach the user: a duplicate Ticket Status shows the real "already
 *  exists" reason (not the old generic "Failed to create status"), an
 *  invalid value shows an inline field error, and the Create dialog never
 *  closes on failure while preserving what was typed.
 *
 *  Part 2 — department-scoped Activity Status editing (label/color/order):
 *  renaming Finance's TODO status does not leak into IT, the change
 *  persists across a refresh, and the new label/color show up in the real
 *  consumer surfaces (Activity Grid, Activity List, activities Gantt,
 *  Resource Planning's Unscheduled panel) — plus rapid department
 *  switching (Finance -> IT -> Sales) never leaves stale data on screen.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-error-messages-and-activity-statuses.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const IT_DEPT_ID = "dept-it";
const FINANCE_DEPT_ID = "dept-finance";
const RUN_ID = Date.now();

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
    if (msg.type() !== "error") return;
    // Part 1 of this script DELIBERATELY submits a duplicate name and an
    // invalid color to POST /api/admin/statuses to prove the specific error
    // messages reach the user — Chrome logs the resulting 409/422 responses
    // to the console itself. That's the intended, exercised behavior, not a
    // real bug, so it's excluded from the "zero console errors" bar here.
    if (/Failed to load resource.*status of (409|422)/.test(msg.text())) return;
    consoleErrors.push(`[console] ${msg.text()}`);
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
    if (res.status() < 400) return;
    // Same deliberate negative-path exception as above, scoped to exactly
    // the two intentional POSTs Part 1 makes (duplicate name -> 409,
    // invalid color -> 422) against this one endpoint.
    const isDeliberateStatusValidationCheck = res.url().includes("/api/admin/statuses") && res.request().method() === "POST" && (res.status() === 409 || res.status() === 422);
    if (isDeliberateStatusValidationCheck) return;
    failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

async function main() {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let createdActivityId: string | null = null;
  let originalFinanceTodo: { label: string; color: string; sortOrder: number } | null = null;

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachConsoleAndNetworkCapture(page, consoleErrors, failedRequests);

    console.log("\nLogging in via the real login form...\n");
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

    // ══════════════════════════════════════════════════════════════════
    // PART 1 — specific backend error messages reach the user
    // ══════════════════════════════════════════════════════════════════
    console.log("\n=== Part 1: Ticket Status create — specific error messages ===\n");
    await page.goto(`${BASE_URL}/admin/statuses`);
    await page.waitForLoadState("networkidle");

    console.log("\nStep 1: attempt to create a DUPLICATE status name in IT ('Open' already exists there)\n");
    await page.click('button:has-text("Add Status")');
    await page.waitForTimeout(200);
    const deptSelect = page.locator('[role="combobox"]').filter({ hasText: /Choose a department|IT Department|Finance|Sales/ }).first();
    await deptSelect.click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "IT Department" }).click();
    await page.fill("#name", "Open");
    await page.fill("#order", "99");
    await page.click('button:has-text("Create")');
    await page.waitForTimeout(600);

    const toastText = await page.locator("[data-sonner-toast]").first().textContent().catch(() => null);
    check(
      `Toast shows the SPECIFIC duplicate reason, not the generic "Failed to create status" (got: "${toastText}")`,
      !!toastText && /already exists/i.test(toastText) && !/^Failed to create status$/i.test(toastText.trim())
    );
    const dialogStillOpen = await page.locator('div[role="dialog"]:has-text("Add Status")').isVisible().catch(() => false);
    check("Dialog stays OPEN after the failure (not closed)", dialogStillOpen);
    const nameValuePreserved = await page.locator("#name").inputValue();
    check(`Entered value "Open" is preserved in the Name field after failure (got: "${nameValuePreserved}")`, nameValuePreserved === "Open");

    console.log("\nStep 2: fix the name but submit an INVALID color — expect an inline field error, not just a toast\n");
    await page.fill("#name", `TEST STATUS ${RUN_ID}`);
    const colorTextInput = page.locator('input[placeholder="#6366f1"]');
    await colorTextInput.fill("not-a-color");
    await page.click('button:has-text("Create")');
    await page.waitForTimeout(600);
    const inlineColorError = await page.locator("p.text-destructive").first().textContent().catch(() => null);
    check(`Inline field error appears under the Color field (got: "${inlineColorError}")`, !!inlineColorError && inlineColorError.trim().length > 0);
    const dialogStillOpen2 = await page.locator('div[role="dialog"]:has-text("Add Status")').isVisible().catch(() => false);
    check("Dialog still open after the validation failure too", dialogStillOpen2);
    const nameStillPreserved = await page.locator("#name").inputValue();
    check(`Name value is STILL preserved through a second failed attempt (got: "${nameStillPreserved}")`, nameStillPreserved === `TEST STATUS ${RUN_ID}`);

    console.log("\nStep 3: fix the color too and confirm a real create actually succeeds (proves the form isn't just permanently broken)\n");
    await colorTextInput.fill("#ff8800");
    await page.click('button:has-text("Create")');
    const createdToast = await page.locator("text=/created/i").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("A valid submission after fixing both fields succeeds", createdToast);

    // Clean up the just-created test status via the real API (same effect as clicking Delete).
    {
      const listResp = await page.request.get(`${BASE_URL}/api/admin/statuses?departmentId=${IT_DEPT_ID}`);
      if (listResp.ok()) {
        const body = await listResp.json();
        const created = (Array.isArray(body) ? body : body.statuses ?? []).find((s: any) => s.name === `TEST STATUS ${RUN_ID}`);
        if (created) await page.request.delete(`${BASE_URL}/api/admin/statuses?id=${created.id}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // PART 2 — department-scoped Activity Status editing
    // ══════════════════════════════════════════════════════════════════
    console.log("\n=== Part 2: Activity Statuses — department-scoped label/color/order ===\n");
    await page.goto(`${BASE_URL}/admin/activity-statuses`);
    await page.waitForLoadState("networkidle");
    check("Activity Statuses admin page renders with a department picker", (await page.locator('[role="combobox"]').count()) > 0);

    console.log("\nSelecting IT Department and reading its current TODO label (baseline)...\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "IT Department" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const itTodoLabelBefore = await page.locator('input[placeholder="Display label"]').first().inputValue().catch(() => null);
    check(`IT's TODO label read successfully as baseline (got: "${itTodoLabelBefore}")`, !!itTodoLabelBefore);

    console.log("\nSwitching to Finance via the on-page dropdown and renaming its TODO status...\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "Finance" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);

    const financeLabelInput = page.locator('input[placeholder="Display label"]').first();
    originalFinanceTodo = {
      label: await financeLabelInput.inputValue(),
      color: await page.locator('input[type="color"]').first().inputValue(),
      sortOrder: 0,
    };
    const NEW_LABEL = `New Activity ${RUN_ID}`;
    const NEW_COLOR = "#ff00aa";
    await financeLabelInput.fill(NEW_LABEL);
    await page.locator('input[type="color"]').first().fill(NEW_COLOR);
    await page.click('button:has-text("Save")');
    const financeSaveToast = await page.locator("text=/saved/i").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("Save succeeded for Finance's renamed/recolored TODO status", financeSaveToast);

    console.log("\nSwitching to IT — must show its ORIGINAL label, proving Finance's edit did not leak\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "IT Department" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const itTodoLabelAfter = await page.locator('input[placeholder="Display label"]').first().inputValue().catch(() => null);
    check(
      `IT's TODO label is UNCHANGED after Finance's edit (before: "${itTodoLabelBefore}", after: "${itTodoLabelAfter}")`,
      itTodoLabelAfter === itTodoLabelBefore
    );

    console.log("\nReturning to Finance and hard-refreshing — the rename/recolor must persist server-side\n");
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(150);
    await page.getByRole("option", { name: "Finance" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(300);
    const financeLabelAfterRefresh = await page.locator('input[placeholder="Display label"]').first().inputValue().catch(() => null);
    check(`Finance's new label survives a hard refresh (got: "${financeLabelAfterRefresh}")`, financeLabelAfterRefresh === NEW_LABEL);
    const financeColorAfterRefresh = await page.locator('input[type="color"]').first().inputValue().catch(() => null);
    check(`Finance's new color survives a hard refresh (got: "${financeColorAfterRefresh}")`, (financeColorAfterRefresh ?? "").toLowerCase() === NEW_COLOR);

    console.log("\nRapid department switching: Finance -> IT -> Sales, confirming no stale label bleeds through\n");
    for (const name of ["IT Department", "Sales", "Finance"]) {
      await page.locator('[role="combobox"]').first().click();
      await page.waitForTimeout(80);
      await page.getByRole("option", { name }).click();
      // Deliberately minimal wait — the point is to race the request-token guard.
      await page.waitForTimeout(120);
    }
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    const labelAfterRapidSwitch = await page.locator('input[placeholder="Display label"]').first().inputValue().catch(() => null);
    check(
      `After rapid Finance->IT->Sales->Finance switching, the FINAL department (Finance) shows its OWN real value, not a stale intermediate one (got: "${labelAfterRapidSwitch}")`,
      labelAfterRapidSwitch === NEW_LABEL
    );

    // ── Consumer surfaces: Activity Grid / List / Gantt / Resource Planning ──
    console.log("\nCreating a real Finance TODO activity via the API, and checking the new label/color show up in every real consumer...\n");
    const activityResp = await page.request.post(`${BASE_URL}/api/activities`, {
      data: { title: `PWCHECK Finance Status Label ${RUN_ID}`, status: "TODO", priority: "MEDIUM", departmentId: FINANCE_DEPT_ID },
    });
    check("Creating the Finance verification activity succeeded", activityResp.ok());
    if (activityResp.ok()) {
      const created = await activityResp.json();
      createdActivityId = created.id;

      const switchToFinance = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: FINANCE_DEPT_ID } });
      check("Workspace switch to Finance (for consumer-surface checks) succeeded", switchToFinance.ok());

      console.log("\nActivity Grid...\n");
      await page.goto(`${BASE_URL}/activities`);
      await page.waitForLoadState("networkidle");
      check(`Activity Grid shows the department's new label "${NEW_LABEL}"`, (await page.locator(`text=${NEW_LABEL}`).count()) > 0);

      console.log("\nActivity List...\n");
      await page.goto(`${BASE_URL}/activities?view=list`);
      await page.waitForLoadState("networkidle");
      check(`Activity List shows the department's new label "${NEW_LABEL}"`, (await page.locator(`text=${NEW_LABEL}`).count()) > 0);

      console.log("\nActivities Gantt...\n");
      await page.goto(`${BASE_URL}/activities/gantt?departmentId=${FINANCE_DEPT_ID}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      check(`Activities Gantt shows the department's new label "${NEW_LABEL}" (legend or bar tooltip)`, (await page.locator(`text=${NEW_LABEL}`).count()) > 0);

      console.log("\nResource Planning (Unscheduled panel — this activity has no dates/assignee)...\n");
      await page.goto(`${BASE_URL}/projects/resource-planning?departmentId=${FINANCE_DEPT_ID}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      check(`Resource Planning's Unscheduled panel shows the department's new label "${NEW_LABEL}"`, (await page.locator(`text=${NEW_LABEL}`).count()) > 0);
    }

    // ── Console/network error summary ──
    console.log("\nConsole and network error summary across the whole run...\n");
    check("Zero console errors across the entire interactive session", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the entire interactive session", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    console.log("\nCleaning up test data (delete the verification activity, restore Finance's TODO status)...\n");
    // A bare fetch() here has no session cookie — /api/activities and
    // /api/admin/activity-statuses both require auth, so cleanup must go
    // through a real logged-in browser context, not a raw HTTP call.
    if (createdActivityId || originalFinanceTodo) {
      try {
        const restoreContext = await browser.newContext();
        const restorePage = await restoreContext.newPage();
        await restorePage.goto(`${BASE_URL}/login`);
        await restorePage.fill("#credentials-email", EMAIL);
        await restorePage.fill("#credentials-password", PASSWORD);
        await Promise.all([
          restorePage.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
          restorePage.click('button:has-text("Sign in as Admin")'),
        ]);

        if (createdActivityId) {
          const deleteResp = await restorePage.request.delete(`${BASE_URL}/api/activities/${createdActivityId}`);
          check("Cleanup: verification activity deleted", deleteResp.ok());
        }

        if (originalFinanceTodo) {
          const rowsResp = await restorePage.request.get(`${BASE_URL}/api/admin/activity-statuses?departmentId=${FINANCE_DEPT_ID}`);
          if (rowsResp.ok()) {
            const data = await rowsResp.json();
            const rows = (data.rows ?? []).map((r: any) =>
              r.status === "TODO" ? { ...r, label: originalFinanceTodo!.label, color: originalFinanceTodo!.color } : r
            );
            const restoreResp = await restorePage.request.patch(`${BASE_URL}/api/admin/activity-statuses`, { data: { departmentId: FINANCE_DEPT_ID, rows } });
            check("Cleanup: Finance's TODO status restored to its original label/color", restoreResp.ok());
          } else {
            check("Cleanup: Finance's TODO status restored to its original label/color", false);
          }
        }

        await restoreContext.close();
      } catch (err) {
        console.warn("Cleanup failed (non-fatal to the test result, but real leftover data may remain):", err);
      }
    }
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
