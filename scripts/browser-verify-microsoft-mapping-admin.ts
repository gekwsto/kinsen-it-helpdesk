/**
 * Real interactive browser verification for the Microsoft Mapping admin UI
 * (/admin/microsoft-mappings) — the surface that manages
 * MicrosoftDepartmentMapping rows (PROFILE_DEPARTMENT / PROFILE_JOB_TITLE /
 * ENTRA_GROUP / ENTRA_APP_ROLE). This UI itself makes NO live Graph calls
 * except the explicit "Sync directory values" button — everything else is
 * local CRUD, so it's fully testable here regardless of Azure credentials.
 *
 * Also exercises the "Sync directory values" button against this
 * environment's real (dummy-tenant) Azure credentials — proving the
 * documented graceful-failure error message actually reaches the admin UI,
 * end-to-end, not just at the API layer (already unit-tested).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-microsoft-mapping-admin.tsx.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
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
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    // The last is the established, previously-confirmed Chromium DevTools
    // quirk where an unread 204 response body on a DELETE can be reported as
    // net::ERR_ABORTED despite the request completing successfully (see
    // earlier admin-config browser-verify scripts this session).
    const isBenign = isAborted && (req.url().includes("_rsc=") || (req.url().includes("/api/notifications") && req.method() === "GET") || (req.url().includes("/api/admin/microsoft-mappings/") && req.method() === "DELETE"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    // The directory-sync 502 (Graph unreachable with dummy creds) is the
    // EXPECTED, intentionally-exercised negative path in this exact script —
    // excluded here the same way Part 1's deliberate 409/422 was excluded in
    // the earlier photo-sync/error-message scripts, not because it's hidden,
    // but because it's the thing under test, not noise.
    const isExpectedSyncFailure = res.url().includes("/api/admin/microsoft-directory/values/sync") && res.status() === 502;
    if (res.status() >= 400 && !isExpectedSyncFailure) failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let createdMappingId: string | undefined;

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachConsoleAndNetworkCapture(page, consoleErrors, failedRequests);

    console.log("\nLogging in as admin...\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Login redirected away from /login", !page.url().includes("/login"));

    console.log("\nNavigating to /admin/microsoft-mappings...\n");
    await page.goto(`${BASE_URL}/admin/microsoft-mappings`);
    await page.waitForLoadState("networkidle");
    check("Microsoft Mappings admin page renders", (await page.locator("text=Add Mapping").count()) > 0);

    // ── Create a mapping via the real form ──
    console.log("\nCreating a real Microsoft mapping via the admin form...\n");
    const dept = await prisma.department.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
    check("A real active department exists to target", dept !== null);

    await page.click("text=Add Mapping");
    await page.waitForTimeout(300);

    // Source type defaults to PROFILE_DEPARTMENT — fill the value field.
    const valueInput = page.locator('input[placeholder*="Systems Operations"]').first();
    const testValue = `Test Mapping Value ${RUN_ID}`;
    await valueInput.fill(testValue);

    if (dept) {
      const deptSelect = page.locator('[role="combobox"]').filter({ hasText: /Select department|./ }).nth(1);
      await deptSelect.click().catch(() => {});
      await page.waitForTimeout(200);
      const option = page.getByRole("option", { name: dept.name }).first();
      if ((await option.count()) > 0) await option.click();
    }

    const createButton = page.locator('button:has-text("Create Mapping")');
    await createButton.click();
    const createdToast = await page.locator("[data-sonner-toast]").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    const toastText = createdToast ? await page.locator("[data-sonner-toast]").first().textContent().catch(() => null) : null;
    check(`Mapping creation succeeded (toast: "${toastText}")`, createdToast && !!toastText && !/fail|error|required/i.test(toastText));

    await page.waitForTimeout(500);
    check("New mapping value appears in the table", (await page.locator(`text=${testValue}`).count()) > 0);

    // Look up what was actually created, for cleanup + edit/delete steps.
    const created = await prisma.microsoftDepartmentMapping.findFirst({ where: { microsoftValue: testValue } });
    createdMappingId = created?.id;
    check("Exactly one mapping row was created in the database (no duplicate)", (await prisma.microsoftDepartmentMapping.count({ where: { microsoftValue: testValue } })) === 1);

    // ── Delete it via the real UI ──
    console.log("\nDeleting the mapping via the admin UI...\n");
    const row = page.locator("tr", { hasText: testValue });
    const deleteButton = row.locator("button").last();
    await deleteButton.click();
    await page.waitForTimeout(300);
    const confirmButton = page.locator('button:has-text("Delete")').last();
    if ((await confirmButton.count()) > 0) await confirmButton.click();
    await page.waitForTimeout(500);
    const stillExists = await prisma.microsoftDepartmentMapping.count({ where: { microsoftValue: testValue } });
    check("Mapping was actually deleted from the database via the UI", stillExists === 0);
    if (stillExists === 0) createdMappingId = undefined;
    check("Deleted mapping no longer appears in the table", (await page.locator(`text=${testValue}`).count()) === 0);

    // ── Directory sync button — real call against this env's (dummy-tenant) credentials ──
    // The sync (RefreshCw) button is icon-only (no visible text, only a
    // `title` attribute) and only renders for a directory-backed source type
    // (PROFILE_DEPARTMENT/PROFILE_JOB_TITLE) — ENTRA_GROUP (used above) is
    // not directory-backed, so re-open the dialog and switch source type first.
    console.log("\nClicking 'Sync directory values' — expecting the documented graceful-failure error against this environment's dummy Azure credentials...\n");
    await page.click("text=Add Mapping");
    await page.waitForTimeout(300);
    const sourceTypeSelect = page.locator('[role="combobox"]').first();
    await sourceTypeSelect.click();
    await page.waitForTimeout(200);
    const profileDeptOption = page.getByRole("option", { name: /Profile.*Department|Department/i }).first();
    if ((await profileDeptOption.count()) > 0) await profileDeptOption.click();
    await page.waitForTimeout(200);

    const syncButton = page.locator('button[title="Sync department and job title values from Microsoft"]').first();
    if ((await syncButton.count()) > 0) {
      await syncButton.click();
      const errorToast = await page.locator("text=/Microsoft Graph|Directory.Read.All|rejected the app credentials|Could not reach/i").first().waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
      check("Directory sync failure shows a SPECIFIC Graph-related error (not a generic crash) against dummy credentials", errorToast);
    } else {
      check("Sync button was present to test", false);
    }
    await page.click('button:has-text("Cancel")').catch(() => {});

    console.log("\nConsole and network error summary...\n");
    check("Zero unexpected console errors", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    if (createdMappingId) {
      await prisma.microsoftDepartmentMapping.delete({ where: { id: createdMappingId } }).catch(() => {});
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
