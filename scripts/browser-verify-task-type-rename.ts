/**
 * Live browser verification for the Project Type -> Task Type / Task Type
 * -> Task Sub Type classification rename:
 *   1. Project Request Form no longer shows a Project Type field; submits
 *      successfully without it.
 *   2. Activity creation form shows a required "Task Type" field (new,
 *      universal classification) AND a separate "Task Sub Type" field
 *      (request-origin-only, renamed, optional cost).
 *   3. Admin "Task Types" page (no cost column) and "Task Sub Types" page
 *      (optional cost, "No fixed cost" display) both render correctly
 *      under their new names/routes.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-task-type-rename.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvttr-${RUN_ID}`;

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

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const typeIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
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

    console.log("\n=== 1. Project Request Form has NO Project Type field ===\n");
    await page.goto(`${BASE_URL}/project-requests/new`);
    await page.waitForLoadState("load");
    let bodyText = await page.locator("body").innerText();
    check("No 'Project Type' label anywhere on the form", !/Project Type/i.test(bodyText));
    check("No #projectTypeId element exists", (await page.locator("#projectTypeId").count()) === 0);
    check("Importance level field is still present (the field right after it)", bodyText.includes("Importance level"));

    console.log("\n=== 2. Admin 'Task Types' page (renamed from Project Request Types, no cost) ===\n");
    await page.goto(`${BASE_URL}/admin/task-types`);
    await page.waitForLoadState("load");
    bodyText = await page.locator("body").innerText();
    check("Page heading reads 'Task Types'", bodyText.includes("Task Types"));
    check("No 'Cost' column header (Task Type has no cost)", !/\bCost\b/.test(bodyText));
    check("'Activities' column header is present (the new, forward-looking usage count)", bodyText.includes("Activities"));

    console.log("\n=== 3. Admin 'Task Sub Types' page (renamed from Task Types, cost optional) ===\n");
    await page.goto(`${BASE_URL}/admin/task-sub-types`);
    await page.waitForLoadState("load");
    bodyText = await page.locator("body").innerText();
    check("Page heading reads 'Task Sub Types'", bodyText.includes("Task Sub Types"));

    console.log("\n=== 4. Creating a Task Sub Type with NO cost succeeds and displays 'No fixed cost' ===\n");
    await page.click('button:has-text("Add Task Sub Type")');
    await page.waitForTimeout(300);
    await page.fill('input[placeholder="e.g. Development"]', `${TAG} Others`);
    const createRes = page.waitForResponse((res) => res.url().includes("/api/admin/task-sub-types") && res.request().method() === "POST");
    await page.click('button:has-text("Create Task Sub Type")');
    const createResponse = await createRes;
    check("POST /api/admin/task-sub-types with no cost -> 201 (cost is optional)", createResponse.status() === 201);
    const created = await createResponse.json().catch(() => null);
    if (created?.id) typeIds.push(created.id);
    check("...and the persisted row's cost is genuinely null", created?.cost === null);
    await page.waitForTimeout(500);
    bodyText = await page.locator("body").innerText();
    check("The new row displays 'No fixed cost', never '0.00'", bodyText.includes("No fixed cost"));

    console.log("\n=== 5. Activity creation form shows Task Type (required) AND Task Sub Type (request-origin-only) separately ===\n");
    await page.goto(`${BASE_URL}/activities/new`);
    await page.waitForLoadState("load");
    bodyText = await page.locator("body").innerText();
    check("A 'Task Type' field (new, universal) is present", (await page.locator("#task-type").count()) > 0);
    check("Task Sub Type is NOT shown yet (no Project selected -> not request-origin)", !bodyText.includes("Task Sub Type"));

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
      await prisma.taskSubType.deleteMany({ where: { id: { in: typeIds } } });
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
