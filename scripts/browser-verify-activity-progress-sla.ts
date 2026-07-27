/**
 * Real interactive browser verification for department-scoped Activity
 * Progress + SLA config (admin UI). Run manually against a live `npm run
 * dev` server with seeded data. Covers: creating/editing/reordering/
 * disabling/deleting Activity Progress rows in two different departments
 * (IT vs Sales) with genuinely different percentages for the same status,
 * confirming no stale data on workspace switch, validation errors, refresh
 * persistence, and an SLA sanity pass (per-department priority sets/hours).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-activity-progress-sla.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const IT_DEPT_ID = "dept-it";
const SALES_DEPT_ID = "dept-sales";

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

// Populated right before an interaction that is DELIBERATELY expected to
// get a non-2xx response (the usage-analysis guard tests below) — cleared
// immediately after, so only genuinely unexpected failures ever count
// against the final "zero failed requests" assertion.
const expectedErrorUrlSubstrings = new Set<string>();

// Chromium logs its OWN generic "Failed to load resource: the server
// responded with a status of 409 (Conflict)" console message for every
// non-2xx fetch response — independent of any application code. This
// script deliberately triggers a handful of REAL, intentional 4xx
// responses (the usage-analysis guard tests below) to prove they're
// rejected correctly; those expected rejections must not be conflated with
// a genuine, unexpected console error. Real JS exceptions/pageerrors are
// NEVER suppressed by this — only this one generic browser-network-status
// echo, and only while a deliberate-rejection window is open.
const GENERIC_RESOURCE_LOAD_FAILURE = /Failed to load resource.*status of \d{3}/;

function attachConsoleAndNetworkCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    if (expectedErrorUrlSubstrings.size > 0 && GENERIC_RESOURCE_LOAD_FAILURE.test(msg.text())) return;
    consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    // Two independently-confirmed-benign Chromium abort patterns, unrelated
    // to any application code under test:
    //  - a Next.js RSC prefetch (`_rsc=`) aborted by a subsequent navigation
    //    (same precedent as scripts/browser-verify.ts);
    //  - the notification dropdown's own 60s background poll
    //    (components/notifications/notification-dropdown.tsx) getting
    //    aborted mid-flight by one of this script's many page.goto() calls
    //    — ordinary browser behavior, not a real request failure.
    const isBenignAbortedPrefetch = isAborted && req.url().includes("_rsc=");
    const isBenignAbortedNotificationPoll = isAborted && req.url().includes("/api/notifications") && req.method() === "GET";
    if (!isBenignAbortedPrefetch && !isBenignAbortedNotificationPoll) {
      failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    }
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const isExpected = [...expectedErrorUrlSubstrings].some((s) => res.url().includes(s));
    if (!isExpected) failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
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

    console.log("\nLogging in via the real login form...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", EMAIL);
    await page.fill("#credentials-password", PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    // ── Activity Progress: IT department (deep-link per-department admin
    // page — resolves by the {id} in the URL path itself via
    // requireAnyDepartmentPermission's System Admin bypass, independent of
    // whatever the admin's ACTIVE workspace happens to be; the workspace-
    // scoped /admin/activity-progress page below is tested separately) ──
    console.log("\nActivity Progress — IT department (deep-link admin page)\n");
    await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/activity-progress`);
    await page.waitForLoadState("networkidle");
    check("IT Activity Progress page renders without crashing", (await page.locator("body").count()) > 0);

    const todoPercentInputIT = page.locator("input[type='number']").first();
    await todoPercentInputIT.fill("7");
    await page.click('button:has-text("Save")');
    const itSaveToast = await page.locator("text=/saved/i").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("Toast confirms save after editing IT's first status percentage", itSaveToast);

    await page.reload();
    await page.waitForLoadState("networkidle");
    const reloadedItValue = await page.locator("input[type='number']").first().inputValue();
    check("IT's edited percentage (7) persists after a full page reload", reloadedItValue === "7");

    // ── Activity Progress: Sales department (must NOT show IT's edited value — no stale data) ──
    console.log("\nActivity Progress — Sales department (deep-link admin page)\n");
    await page.goto(`${BASE_URL}/admin/departments/${SALES_DEPT_ID}/activity-progress`);
    await page.waitForLoadState("networkidle");
    const salesFirstValue = await page.locator("input[type='number']").first().inputValue();
    check("Sales' own first-status percentage is independent of IT's edited value (no stale cross-department data)", salesFirstValue !== "7");
    console.log(`  (Sales first status value: ${salesFirstValue}%, IT's edited value: 7% — different rows, different departments)`);

    await page.locator("input[type='number']").first().fill("13");
    await page.click('button:has-text("Save")');
    const salesSaveToast = await page.locator("text=/saved/i").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    check("Toast confirms save after editing Sales' first status percentage", salesSaveToast);
    await page.waitForTimeout(300);

    console.log("\nSwitching back to IT's own deep-link page — must show IT's own 7%, not Sales' 13% (no stale data on navigation)\n");
    await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/activity-progress`);
    await page.waitForLoadState("networkidle");
    const itValueAfterSwitchBack = await page.locator("input[type='number']").first().inputValue();
    check("IT still shows its own 7% after navigating between departments", itValueAfterSwitchBack === "7");

    // ── Workspace-scoped page: switching the ACTIVE workspace must refetch, never show stale data ──
    console.log("\nWorkspace-scoped /admin/activity-progress follows the ACTIVE workspace and refetches on switch (no stale config)\n");
    const switchToIt = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: IT_DEPT_ID } });
    check("Workspace switch to IT succeeded", switchToIt.ok());
    await page.goto(`${BASE_URL}/admin/activity-progress`);
    await page.waitForLoadState("networkidle");
    const workspaceItValue = await page.locator("input[type='number']").first().inputValue();
    check("Workspace-scoped page shows IT's real 7% when IT is the active workspace", workspaceItValue === "7");

    const switchToSales = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: SALES_DEPT_ID } });
    check("Workspace switch to Sales succeeded", switchToSales.ok());
    await page.goto(`${BASE_URL}/admin/activity-progress`);
    await page.waitForLoadState("networkidle");
    const workspaceSalesValue = await page.locator("input[type='number']").first().inputValue();
    check("Workspace-scoped page shows Sales' real 13% after switching (not IT's stale 7%)", workspaceSalesValue === "13");
    await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: IT_DEPT_ID } });

    // ── Validation: invalid percentage rejected client-side (back on IT's deep-link page, deterministic) ──
    console.log("\nValidation: an out-of-range percentage shows an inline error and blocks save\n");
    await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/activity-progress`);
    await page.waitForLoadState("networkidle");
    await page.locator("input[type='number']").first().fill("150");
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(400);
    const hasValidationError = (await page.locator("text=/between 0 and 100/i").count()) > 0 || (await page.locator("text=/fix the highlighted/i").count()) > 0;
    check("Entering 150% shows a validation error instead of silently saving", hasValidationError);
    await page.reload();
    await page.waitForLoadState("networkidle");
    const valueAfterInvalidAttempt = await page.locator("input[type='number']").first().inputValue();
    check("The invalid 150% was never persisted (still 7% after reload)", valueAfterInvalidAttempt === "7");

    // Note: a plain "disable any row and check it persists" test is
    // deliberately NOT run here on an arbitrary row — real seeded
    // activities in this department may already use that status, in which
    // case the usage-analysis guard (tested explicitly below, with a
    // purpose-built activity) correctly BLOCKS the disable. Disable
    // persistence for a genuinely unused status is proven by the guarded
    // test below instead, where "unused" is verified rather than assumed.

    // ── Delete a row (with confirm dialog) then add it back — targets
    // CANCELLED specifically, verified via a real API count query first, so
    // this test doesn't collide with the usage-analysis guard if seed data
    // ever changes (a status genuinely in use would be correctly BLOCKED,
    // which is a different, already-covered scenario, not this one) ──
    console.log("\nDelete: removing a status row requires confirmation, then it can be re-added\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    const cancelledUsageResp = await page.request.get(`${BASE_URL}/api/activities?departmentId=${IT_DEPT_ID}&status=CANCELLED`);
    const cancelledActivities = await cancelledUsageResp.json().catch(() => []);
    const cancelledUnused = Array.isArray(cancelledActivities) && cancelledActivities.length === 0;
    const rowsBeforeDelete = await page.locator("button[role='switch']").count();
    const deleteButtons = page.locator("button[title='Delete']");
    const deletableCount = await deleteButtons.count();
    if (deletableCount > 0 && cancelledUnused) {
      await deleteButtons.last().click();
      await page.waitForTimeout(200);
      const confirmDialogVisible = (await page.locator("text=/Delete status mapping/i").count()) > 0;
      check("A confirmation dialog appears before the destructive delete", confirmDialogVisible);
      await page.click('button:has-text("Delete"):visible >> nth=-1');
      await page.waitForTimeout(500);
      const rowsAfterDelete = await page.locator("button[role='switch']").count();
      check("Row count decreased by exactly one after confirmed delete", rowsAfterDelete === rowsBeforeDelete - 1);

      const addButton = page.locator('button:has-text("Add status")');
      check("'Add status' affordance appears now that a status is available to add back", (await addButton.count()) > 0);
      if ((await addButton.count()) > 0) {
        await addButton.click();
        await page.waitForTimeout(200);
        const addDialogVisible = (await page.locator("text=/Add activity progress status/i").count()) > 0;
        check("Add-status dialog opens", addDialogVisible);
        await page.click('button:has-text("Add"):visible >> nth=-1');
        await page.waitForTimeout(500);
        const rowsAfterAdd = await page.locator("button[role='switch']").count();
        check("Row count restored after adding the status back", rowsAfterAdd === rowsBeforeDelete);
      }
    } else if (!cancelledUnused) {
      console.log("  (CANCELLED is currently used by real seeded activities in this environment — skipping the plain-delete test; the blocked-delete path is covered by the usage-analysis guard section below)");
    } else {
      check("At least one deletable row existed to test delete on", false);
    }

    // ── Usage-analysis guard: disable/delete must be BLOCKED while a real
    // activity uses the status, with a clear explanation, never a false
    // "success" ──
    console.log("\nUsage-analysis guard: disable is blocked while an activity uses the status\n");
    const projectsListResp = await page.request.get(`${BASE_URL}/api/projects?departmentId=${IT_DEPT_ID}&limit=1`);
    const projectsList = await projectsListResp.json().catch(() => []);
    const anyProjectId: string | undefined = Array.isArray(projectsList) ? projectsList[0]?.id : projectsList?.projects?.[0]?.id;
    let guardActivityId: string | null = null;
    if (anyProjectId) {
      const createResp = await page.request.post(`${BASE_URL}/api/activities`, {
        data: { title: `PWCHECK Usage Guard ${Date.now()}`, status: "ON_HOLD", priority: "MEDIUM", departmentId: IT_DEPT_ID, projectId: anyProjectId },
      });
      if (createResp.ok()) {
        const createdActivity = await createResp.json();
        guardActivityId = createdActivity.id;
      }
    }
    if (guardActivityId) {
      await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/activity-progress`);
      await page.waitForLoadState("networkidle");
      const onHoldSwitch = page.locator('button[aria-label="Disable On Hold"]');
      if ((await onHoldSwitch.count()) > 0) {
        expectedErrorUrlSubstrings.add("/api/admin/activity-progress");
        await onHoldSwitch.click();
        await page.click('button:has-text("Save")');
        await page.waitForTimeout(500);
        const blockedToastVisible = (await page.locator("text=/currently.*status|Cannot disable/i").count()) > 0;
        check("Disabling a status an activity currently uses shows a clear blocking error (never a silent 'saved')", blockedToastVisible);
        await page.reload();
        await page.waitForLoadState("networkidle");
        const stillShowsDisableLabel = (await page.locator('button[aria-label="Disable On Hold"]').count()) > 0;
        check("On Hold's row is still actually enabled after the blocked attempt (server truth wins, no false success)", stillShowsDisableLabel);
        expectedErrorUrlSubstrings.delete("/api/admin/activity-progress");
      } else {
        check("On Hold row was present to test the disable guard on", false);
      }

      // Clean up: delete the guard activity, then confirm disable is now allowed.
      await page.request.delete(`${BASE_URL}/api/activities/${guardActivityId}`);
      await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/activity-progress`);
      await page.waitForLoadState("networkidle");
      await page.locator('button[aria-label="Disable On Hold"]').click();
      await page.click('button:has-text("Save")');
      await page.waitForTimeout(500);
      const allowedToast = (await page.locator("text=/saved/i").count()) > 0;
      check("Disabling the SAME status is now allowed once the activity no longer uses it", allowedToast);
      // Restore to enabled for a clean end-state.
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.locator('button[aria-label="Enable On Hold"]').click();
      await page.click('button:has-text("Save")');
      await page.waitForTimeout(500);
    } else {
      check("Could not create a real activity to test the usage-analysis guard on (skipped)", false);
    }

    // ── SLA CRUD separation, exercised on IT first: Create Level, Reset (not
    // delete), Disable, Delete — each verified via the level's own stable
    // data-testid row, not fragile text/class scoping ──
    console.log("\nSLA — IT department: Create Level atomically creates both the priority and its starter SLA hours\n");
    await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/sla`);
    await page.waitForLoadState("networkidle");
    const itLevelNamesBefore = await page.locator("span.text-sm.font-medium.truncate").allTextContents();

    const newLevelName = `PWCHECK Level ${Date.now()}`;
    await page.click('button:has-text("New Level")');
    await page.waitForTimeout(200);
    await page.fill('input[placeholder="e.g. Urgent"]', newLevelName);
    const [createResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/priorities") && r.request().method() === "POST"),
      page.click('button:has-text("Add"):visible >> nth=-1'),
    ]);
    const createdLevel = await createResp.json();
    await page.waitForTimeout(300);
    const newLevelRow = page.locator(`[data-testid="sla-row-${createdLevel.id}"]`);
    check("New level appears in the list immediately after creation", (await newLevelRow.count()) === 1);
    const newLevelHours = await newLevelRow.locator("input[type='number']").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    check("New level got its starter SLA hours (8h first response / 48h resolution) atomically, not a separate step", newLevelHours[0] === "8" && newLevelHours[1] === "48");

    console.log("\nSLA — Reset is a distinct action from Delete: hours revert, the level itself stays\n");
    await newLevelRow.locator("input[type='number']").first().fill("2");
    await page.click('button:has-text("Save Hours")');
    await page.waitForTimeout(500);
    await newLevelRow.locator("button[title='Reset hours to defaults']").click();
    await page.waitForTimeout(200);
    const resetDialogVisible = (await page.locator("text=/Reset SLA hours/i").count()) > 0;
    check("Reset shows its own confirmation dialog, distinctly labeled from Delete", resetDialogVisible);
    await page.click('button:has-text("Reset hours"):visible >> nth=-1');
    await page.waitForTimeout(500);
    check("The level itself still exists after Reset (Reset never deletes the level)", (await newLevelRow.count()) === 1);
    const hoursAfterReset = await newLevelRow.locator("input[type='number']").first().inputValue();
    check("Hours actually reverted to the starter value (8h) after Reset", hoursAfterReset === "8");

    console.log("\nSLA — Disable is a distinct action: level + hours stay, only availability for new selection changes\n");
    await newLevelRow.locator("button[title*='Disable']").click();
    await page.waitForTimeout(500);
    check("Level row shows a Disabled badge after toggling off (level itself not removed)", (await newLevelRow.locator("text=Disabled").count()) > 0);
    const hoursStillPresentAfterDisable = await newLevelRow.locator("input[type='number']").first().inputValue();
    check("Disabling did not touch the hours (still 8h from the reset above)", hoursStillPresentAfterDisable === "8");

    console.log("\nSLA — Delete Level: real removal, only reachable because this test level has zero tickets\n");
    await newLevelRow.locator("button[title='Delete level']").click();
    await page.waitForTimeout(200);
    const deleteLevelDialogVisible = (await page.locator("text=/Delete SLA level/i").count()) > 0;
    check("Delete shows its own confirmation dialog, distinctly labeled from Reset", deleteLevelDialogVisible);
    const [deleteResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/priorities") && r.request().method() === "DELETE"),
      page.click('button:has-text("Delete level"):visible >> nth=-1'),
    ]);
    check("Delete request completed with 204 (real removal)", deleteResp.status() === 204);
    await page.waitForTimeout(300);
    check("The level row is actually gone from the DOM after confirmed Delete", (await newLevelRow.count()) === 0);

    // ── IT vs Sales differ: create a Sales-only "Urgent" level via the same
    // UI flow, matching the user's own IT{High,Medium,Low} vs
    // Sales{Urgent,High,Medium,Low} example — proves real, UI-driven
    // per-department differentiation rather than assuming pre-existing
    // seed data happens to already differ ──
    console.log("\nSLA — Sales department: creating an Urgent level (IT has no such level) proves independent per-department level sets\n");
    await page.goto(`${BASE_URL}/admin/departments/${SALES_DEPT_ID}/sla`);
    await page.waitForLoadState("networkidle");
    const salesLevelNamesBefore = await page.locator("span.text-sm.font-medium.truncate").allTextContents();
    check("Sales starts without an 'Urgent' level (same starter set as IT: High/Medium/Low)", !salesLevelNamesBefore.includes("Urgent"));

    await page.click('button:has-text("New Level")');
    await page.waitForTimeout(200);
    await page.fill('input[placeholder="e.g. Urgent"]', "Urgent");
    const [urgentResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/priorities") && r.request().method() === "POST"),
      page.click('button:has-text("Add"):visible >> nth=-1'),
    ]);
    const urgentLevel = await urgentResp.json();
    await page.waitForTimeout(300);
    const salesLevelNamesAfter = await page.locator("span.text-sm.font-medium.truncate").allTextContents();
    check("Sales now has 'Urgent' after creating it via the UI", salesLevelNamesAfter.includes("Urgent"));

    await page.goto(`${BASE_URL}/admin/departments/${IT_DEPT_ID}/sla`);
    await page.waitForLoadState("networkidle");
    const itLevelNamesAfter = await page.locator("span.text-sm.font-medium.truncate").allTextContents();
    check("IT still does NOT have 'Urgent' (Sales' new level did not leak into IT)", !itLevelNamesAfter.includes("Urgent"));
    console.log(`  IT levels: ${itLevelNamesAfter.join(", ")}`);
    console.log(`  Sales levels: ${salesLevelNamesAfter.join(", ")}`);

    // Clean up the Urgent test level (unreferenced, safe to delete via the same real endpoint).
    await page.request.delete(`${BASE_URL}/api/admin/priorities?id=${urgentLevel.id}`);

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
  if (failed > 0) process.exit(1);
}

main();
