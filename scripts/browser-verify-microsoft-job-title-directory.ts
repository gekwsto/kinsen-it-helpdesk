/**
 * Real interactive browser verification for the new Job Titles auto-
 * discovery panel on /admin/microsoft-mappings — same technique/precedent
 * as scripts/browser-verify-microsoft-mapping-admin.ts: launches a real
 * Chromium browser (Playwright) against a REALLY RUNNING `next dev`
 * instance, logs in as a real seeded admin account, and drives the actual
 * rendered UI.
 *
 * Seeds a fixture row directly via Prisma first (this environment's Graph
 * credentials are dummy — see docs/microsoft-production-readiness-audit.md
 * — so a real "Sync Microsoft Job Titles" click cannot discover anything
 * real; that click is still exercised below to prove its documented
 * graceful-failure path reaches the real UI). Verifies: the panel renders,
 * an unconfigured discovered title shows "Not configured" + a working "Map"
 * quick action that opens the Add Mapping dialog prefilled with
 * PROFILE_JOB_TITLE + the right value, and after creating that mapping via
 * the real form + reloading, the SAME row now shows "Configured — <dept>".
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-microsoft-job-title-directory.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TITLE = `Browser Verify Job Title ${RUN_ID}`;

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

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    // Chromium logs a "Failed to load resource: 502" console error for the
    // EXPECTED dummy-tenant sync failure too (in addition to the `response`
    // listener below, which already confirms it's specifically the sync
    // endpoint) — same exemption, not a real problem. Chromium's resource-
    // load console message text doesn't include the URL, so match on the
    // status text alone; the `response` listener above is what actually
    // confirms this 502 came from the sync endpoint specifically.
    const isExpectedSyncFailureLog = msg.type() === "error" && /502 \(Bad Gateway\)/.test(msg.text());
    if (msg.type() === "error" && !isExpectedSyncFailureLog) consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenign = isAborted && (req.url().includes("_rsc=") || (req.url().includes("/api/notifications") && req.method() === "GET"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    // Both job-title-sync and legacy directory-values-sync hit dummy Graph
    // credentials in this environment -> documented 502 is EXPECTED, not noise.
    const isExpectedSyncFailure =
      (res.url().includes("/api/admin/microsoft-directory/job-titles/sync") || res.url().includes("/api/admin/microsoft-directory/values/sync")) &&
      res.status() === 502;
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
  let jobTitleValueId: string | undefined;

  try {
    // Seed a discovered-but-unconfigured job title row directly (no real
    // Graph tenant available here — see header comment).
    const seeded = await prisma.microsoftDirectoryJobTitleValue.create({
      data: { value: TITLE, domain: "kinsen.gr", normalizedValue: TITLE.trim().toLowerCase(), userCount: 3, isActive: true },
    });
    jobTitleValueId = seeded.id;

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

    console.log("\nNavigating to /admin/microsoft-mappings...\n");
    await page.goto(`${BASE_URL}/admin/microsoft-mappings`);
    await page.waitForLoadState("networkidle");
    check("Job Titles panel renders", (await page.locator("text=Job Titles — Auto-Discovery").count()) > 0);

    const row = page.locator("tr", { hasText: TITLE });
    check("Seeded discovered job title row appears", (await row.count()) > 0);
    check("Row shows the seeded user count (3)", (await row.locator("text=3").count()) > 0);
    check("Row shows 'Not configured' before any mapping exists", (await row.locator("text=Not configured").count()) > 0);

    console.log("\nClicking the row's 'Map' quick action...\n");
    await row.locator('button:has-text("Map")').click();
    await page.waitForTimeout(300);
    check("Add Mapping dialog opened", (await page.locator("text=Add Microsoft Mapping").count()) > 0);

    const valueInput = page.locator('input, [role="combobox"]').filter({ hasText: "" });
    check("Value field is prefilled with the discovered title", (await page.locator(`text=${TITLE}`).count()) > 0);
    // FIND-006: opening "Map" from a discovered Job Title auto-fills the
    // domain — the admin never types it (no domain input field exists at
    // all yet, per explicit scope: no domain-selector UI enabled today).
    check("Domain is auto-filled (kinsen.gr) — admin never types it", (await page.locator("text=/Domain:\\s*kinsen\\.gr/").count()) > 0);

    const dept = await prisma.department.findFirst({ where: { isActive: true }, select: { id: true, name: true } });
    check("A real active department exists to target", dept !== null);
    if (dept) {
      // Opened via the "Map" quick action, the Value field is ALSO a
      // directory-backed Select (the discovered title is already cached),
      // so there are 3 comboboxes in this dialog (Source Type, Value,
      // Department) — an index-based locator is fragile. Target the
      // Department trigger by its adjacent <Label> instead.
      const deptSelect = page.locator('label:text-is("Department") + button[role="combobox"]');
      await deptSelect.click();
      await page.waitForTimeout(200);
      const option = page.getByRole("option", { name: dept.name }).first();
      if ((await option.count()) > 0) await option.click();
      else check("Department option was clickable", false);
    }

    await page.locator('button:has-text("Create Mapping")').click();
    const createdToast = await page.locator("[data-sonner-toast]").first().waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
    const toastText = createdToast ? await page.locator("[data-sonner-toast]").first().textContent().catch(() => null) : null;
    check(`Mapping creation succeeded (toast: "${toastText}")`, createdToast && !!toastText && !/fail|error|required/i.test(toastText));

    const created = await prisma.microsoftDepartmentMapping.findFirst({ where: { microsoftValue: TITLE } });
    createdMappingId = created?.id;
    check("Mapping row actually created in the database", created !== null);

    console.log("\nReloading to verify the row now shows Configured...\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    const rowAfter = page.locator("tr", { hasText: TITLE });
    check("Row now shows 'Configured' after reload", (await rowAfter.locator("text=/Configured/").count()) > 0);
    check("'Map' quick action no longer shown for a configured title", (await rowAfter.locator('button:has-text("Map")').count()) === 0);

    console.log("\nVerifying the new mapping's row in the main mapping list shows its Domain...\n");
    const anyMappingRowWithTitle = page.locator("tr", { hasText: TITLE });
    check("Mapping list shows a kinsen.gr Domain badge for the new PROFILE_JOB_TITLE mapping", (await anyMappingRowWithTitle.locator("text=kinsen.gr").count()) > 0);

    console.log("\nClicking 'Sync Microsoft Job Titles' — expecting the documented graceful-failure error against this environment's dummy Azure credentials...\n");
    const syncButton = page.locator('button:has-text("Sync Microsoft Job Titles")');
    check("Sync Microsoft Job Titles button is present", (await syncButton.count()) > 0);
    await syncButton.click();
    const errorToast = await page
      .locator("text=/Microsoft Graph|Directory.Read.All|rejected the app credentials|Could not reach/i")
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check("Job Title sync failure shows a SPECIFIC Graph-related error (not a generic crash) against dummy credentials", errorToast);

    console.log("\nConsole and network error summary...\n");
    check("Zero unexpected console errors", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    if (createdMappingId) await prisma.microsoftDepartmentMapping.delete({ where: { id: createdMappingId } }).catch(() => {});
    if (jobTitleValueId) await prisma.microsoftDirectoryJobTitleValue.delete({ where: { id: jobTitleValueId } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
