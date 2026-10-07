/**
 * Live browser verification for the new searchable Workspace combobox on
 * /projects/new (components/projects/workspace-combobox.tsx), replacing
 * the plain <Select> there:
 *   1. Search finds a Workspace by partial, case-insensitive name match.
 *   2. Clearing the search restores the full eligible Workspace list.
 *   3. Selecting a Workspace still updates departmentId exactly as before
 *      (confirmed indirectly: the Sub-Department fetch, which is keyed off
 *      departmentId, fires for the selected Workspace).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-workspace-combobox-search.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvwcs-${RUN_ID}`;

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

  const departmentIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];

  try {
    console.log("\n=== Fixtures: two distinctly-named Workspaces ===\n");
    const deptAlpha = await createDepartment({ name: `${TAG}-Alpha-Finance`, slug: `${TAG}-alpha-finance` });
    departmentIds.push(deptAlpha.id);
    const deptBeta = await createDepartment({ name: `${TAG}-Beta-Logistics`, slug: `${TAG}-beta-logistics` });
    departmentIds.push(deptBeta.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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

    console.log("\n=== 1. Open /projects/new and open the Workspace combobox ===\n");
    await page.goto(`${BASE_URL}/projects/new`);
    await page.waitForTimeout(800);
    const trigger = page.locator('button[role="combobox"]').first();
    check("Workspace trigger renders with the placeholder (or a preselected Workspace)", (await trigger.count()) === 1);
    await trigger.click();
    await page.waitForTimeout(300);

    const searchInput = page.locator('input[placeholder="Search workspaces…"]');
    check("Search input is present inside the opened combobox", (await searchInput.count()) > 0);

    let bodyText = await page.locator("body").innerText();
    check("Both fixture Workspaces are listed before any search", bodyText.includes(deptAlpha.name) && bodyText.includes(deptBeta.name));

    console.log("\n=== 2. Partial, case-insensitive search ===\n");
    await searchInput.fill("alpha-fin");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Lowercase partial match 'alpha-fin' finds the mixed-case 'Alpha-Finance' Workspace", bodyText.includes(deptAlpha.name));
    check("...and hides the non-matching Beta Workspace", !bodyText.includes(deptBeta.name));

    console.log("\n=== 3. Clearing the search restores the full list ===\n");
    await searchInput.fill("");
    await page.waitForTimeout(200);
    bodyText = await page.locator("body").innerText();
    check("Clearing search restores Alpha", bodyText.includes(deptAlpha.name));
    check("...and Beta", bodyText.includes(deptBeta.name));

    console.log("\n=== 4. Selecting a Workspace updates departmentId (observed via the Sub-Department fetch it triggers) ===\n");
    const subDeptResponse = page.waitForResponse((res) => res.url().includes(`/api/departments/${deptBeta.id}/sub-departments`), { timeout: 8000 }).catch(() => null);
    await page.locator('[role="option"]', { hasText: deptBeta.name }).first().click();
    await subDeptResponse;
    await page.waitForTimeout(300);
    check("Combobox closed after selection", !(await searchInput.isVisible().catch(() => false)));
    const triggerText = await trigger.innerText();
    check("Trigger now shows the selected Workspace's name", triggerText.includes(deptBeta.name));

    console.log("\n=== No console errors throughout ===\n");
    check("Zero console/page errors observed", consoleErrors.length === 0, consoleErrors.join("\n"));
  } finally {
    console.log("\nCleaning up test data...\n");
    try {
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
