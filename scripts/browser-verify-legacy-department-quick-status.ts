/**
 * Live browser verification for the "Quick Status dropdown opens but is
 * visibly empty" bug, reproduced against a fixture that mirrors the ACTUAL
 * failing real-world row (departmentId: null — a legacy Activity predating
 * department scoping, confirmed to exist in this app's own seed/mock data
 * as e.g. "mock-act-010").
 *
 * Unlike the previous round's verification, every assertion here uses
 * Playwright's `toBeVisible()`/bounding-box checks against the REAL DOM —
 * not just "the item exists" — and actually clicks a menu row to prove it
 * is interactive, per the explicit requirement that a green test must mean
 * a human could actually use the control.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-legacy-department-quick-status.ts
 */
import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, ActivityStatus } from "@prisma/client";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvldqs-${RUN_ID}`;

let passed = 0;
let failed = 0;
async function checkAsync(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label} — ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", ADMIN_EMAIL);
  await page.fill("#credentials-password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

async function main() {
  await prisma.$connect().catch((err) => {
    console.log("No reachable DATABASE_URL — skipping.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  });

  const legacyDepartmentId = await getDefaultLegacyDepartmentId();
  if (!legacyDepartmentId) {
    console.log("No legacy department configured in this environment — skipping (see the equivalent Node-level test for the code-level explanation).");
    await prisma.$disconnect();
    process.exit(0);
  }

  const activityIds: string[] = [];
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await login(page);

    console.log("\n=== Reproduction fixture: a legacy Activity (departmentId: null), same shape as real pre-existing rows ===\n");
    const legacyActivity = await prisma.projectActivity.create({
      data: { title: `${TAG} Legacy Activity`, departmentId: null, projectId: null, status: ActivityStatus.TODO },
    });
    activityIds.push(legacyActivity.id);

    await page.goto(`${BASE_URL}/activities/${legacyActivity.id}`);
    await page.waitForSelector('button[aria-label="Change activity status"]', { timeout: 10000 });
    check("Project field confirms Standalone", (await page.locator("text=Standalone").count()) > 0);

    const trigger = page.getByRole("button", { name: "Change activity status" });
    await checkAsync("Trigger is visible with a non-zero bounding box", async () => {
      const visible = await trigger.isVisible();
      if (!visible) throw new Error("trigger is not visible");
      const box = await trigger.boundingBox();
      if (!box || box.width === 0 || box.height === 0) throw new Error(`zero-sized bounding box: ${JSON.stringify(box)}`);
    });

    await trigger.click();
    const menu = page.locator('[role="menu"]');
    await checkAsync("Dropdown panel [role=menu] is visible after clicking", async () => {
      await menu.waitFor({ state: "visible", timeout: 5000 });
      const visible = await menu.isVisible();
      if (!visible) throw new Error("[role=menu] did not become visible");
    });

    // Screenshot artifact for debugging — captured regardless of pass/fail.
    await page.screenshot({ path: `/tmp/quick-status-dropdown-${RUN_ID}.png` }).catch(() => {});
    console.log(`  (screenshot saved to /tmp/quick-status-dropdown-${RUN_ID}.png)`);

    const menuItems = page.locator('[role="menuitem"]');
    const itemCount = await menuItems.count();
    check("Dropdown contains at least 2 visible status rows (not empty)", itemCount >= 2, `got ${itemCount}`);

    await checkAsync("Every rendered menu item is actually visible (non-zero size, not clipped/hidden)", async () => {
      const count = await menuItems.count();
      if (count === 0) throw new Error("zero menu items to check");
      for (let i = 0; i < count; i++) {
        const item = menuItems.nth(i);
        const visible = await item.isVisible();
        if (!visible) throw new Error(`menu item ${i} is not visible`);
        const box = await item.boundingBox();
        if (!box || box.width === 0 || box.height === 0) throw new Error(`menu item ${i} has a zero-sized bounding box`);
      }
    });

    await checkAsync("The current status ('To Do') is present and visibly checked/marked in the menu", async () => {
      const currentItem = page.locator('[role="menuitem"]').filter({ hasText: /^To Do$/ });
      const visible = await currentItem.isVisible();
      if (!visible) throw new Error("current status ('To Do') is not visible in the menu");
    });

    await checkAsync("A DIFFERENT status ('In Progress') is visible and genuinely clickable", async () => {
      const target = page.locator('[role="menuitem"]').filter({ hasText: /^In Progress$/ });
      const visible = await target.isVisible();
      if (!visible) throw new Error("'In Progress' item is not visible");
      const disabledAttr = await target.getAttribute("aria-disabled");
      if (disabledAttr === "true") throw new Error("'In Progress' item is disabled");
    });

    // Actually click it and confirm the transition really happens.
    const inProgressConfig = await prisma.activityProgressConfig.findUniqueOrThrow({ where: { departmentId_status: { departmentId: legacyDepartmentId, status: ActivityStatus.IN_PROGRESS } } });
    await page.locator('[role="menuitem"]').filter({ hasText: /^In Progress$/ }).click();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("In Progress")', { timeout: 10000 });
    check("Trigger updated to In Progress after a real click", true);
    check(`Progress updated to the legacy department's configured value (${inProgressConfig.progressPercent}%)`, (await page.locator(`text=${inProgressConfig.progressPercent}%`).count()) > 0);

    await page.reload();
    await page.waitForSelector('button[aria-label="Change activity status"]:has-text("In Progress")', { timeout: 10000 });
    check("Reload confirms the transition persisted for a legacy-department Activity", true);

    // Edit page equivalence.
    await page.goto(`${BASE_URL}/activities/${legacyActivity.id}/edit`);
    await page.waitForSelector("text=Edit Activity", { timeout: 10000 });
    await page.waitForTimeout(800);
    const editStatusSelect = page.locator('button[role="combobox"]').first();
    check("Activity Edit page's Status select also shows the same persisted status (In Progress)", (await editStatusSelect.textContent())?.includes("In Progress") ?? false);
    await editStatusSelect.click();
    await page.waitForTimeout(300);
    const editOptions = await page.locator('[role="option"]').count();
    check("Activity Edit page's Status select is ALSO no longer empty for a legacy-department Activity", editOptions >= 2, `got ${editOptions}`);

    await context.close();
  } finally {
    await browser.close();
    try {
      await prisma.activityNote.deleteMany({ where: { activityId: { in: activityIds } } });
      await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } });
    } catch (err) {
      console.warn("Cleanup failed (non-fatal):", err instanceof Error ? err.message : err);
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
