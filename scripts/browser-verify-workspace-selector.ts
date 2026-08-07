/**
 * Real interactive browser verification of the workspace selector dropdown
 * (components/workspace/workspace-selector.tsx): opens the trigger, confirms
 * the initial take-bounded list + "All Workspaces" + search box render, types
 * a search query and confirms debounced server-side results appear (finding
 * a department seeded OUTSIDE the initial page), confirms the results panel
 * is scrollable, and confirms selecting a workspace switches the active
 * workspace and closes the menu — all against the real running dev app, not
 * a mocked component tree.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-workspace-selector.ts
 * Requires a reachable DATABASE_URL and a running dev server — skips if
 * either is unavailable.
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";
import { WORKSPACE_LIST_TAKE } from "@/lib/services/workspace-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const NAME_TAG = `bvws-${RUN_ID}`;

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
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenign = isAborted && (req.url().includes("_rsc=") || (req.url().includes("/api/notifications") && req.method() === "GET"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
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
  const failedRequests: string[] = [];

  try {
    // Seed enough departments that at least one sorts AFTER the initial
    // WORKSPACE_LIST_TAKE page (alphabetically), so search is proven to
    // reach the server, not just filter the already-loaded 20.
    const total = WORKSPACE_LIST_TAKE + 3;
    const created: { id: string; name: string }[] = [];
    for (let i = 0; i < total; i++) {
      const idx = String(i).padStart(2, "0");
      const dept = await createDepartment({ name: `${NAME_TAG}-${idx}`, slug: `${NAME_TAG}-${idx}` });
      departmentIds.push(dept.id);
      created.push({ id: dept.id, name: dept.name });
    }
    const beyondFirstPage = created[created.length - 1]; // "-NN" sorts after the first WORKSPACE_LIST_TAKE alphabetically

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
    await page.waitForLoadState("networkidle");
    check("Login redirected away from /login", !page.url().includes("/login"));

    // Scoped precisely to the workspace selector's own trigger (the button
    // rendering the "Workspace" label) rather than a generic
    // `svg.lucide-chevron-down` locator, which also matches the unrelated
    // user-menu chevron in the topbar.
    const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
    check("Workspace trigger found", (await trigger.count()) === 1);

    console.log("\nOpening the workspace dropdown...\n");
    await trigger.click();
    await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 }).catch(() => {});

    check("Trigger reports data-state=open", (await trigger.getAttribute("data-state")) === "open");
    check("Search input rendered", (await page.locator('input[placeholder="Search workspaces..."]').count()) === 1);
    check('"All Workspaces" item rendered (ADMIN can view all departments)', (await page.locator("text=All Workspaces").count()) > 0);

    const resultsPanel = page.locator('[role="menu"] >> css=div.max-h-80.overflow-y-auto');
    check("Scrollable results panel present (max-h-80 overflow-y-auto)", (await resultsPanel.count()) === 1);

    const initialItemCount = await page.locator('[role="menu"] [role="menuitem"]').count();
    // +1 for the pinned "All Workspaces" row.
    check(
      `Initial list shows at most WORKSPACE_LIST_TAKE+1 menu items (got ${initialItemCount}, cap ${WORKSPACE_LIST_TAKE + 1})`,
      initialItemCount <= WORKSPACE_LIST_TAKE + 1
    );
    check(
      "A department seeded beyond the initial page is NOT yet visible (proves the list is server take-bounded, not client-sliced from a fully loaded set)",
      (await page.locator(`text=${beyondFirstPage.name}`).count()) === 0
    );

    console.log("\nTyping a search query for the beyond-page department...\n");
    const searchInput = page.locator('input[placeholder="Search workspaces..."]');
    await searchInput.fill(beyondFirstPage.name);
    // Debounce is 300ms — wait for the loading state to appear then clear,
    // or directly for the result, whichever lands first.
    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      beyondFirstPage.name,
      { timeout: 5000 }
    ).catch(() => {});

    check(
      "Search finds the beyond-page-1 department via the server-side query",
      (await page.locator(`text=${beyondFirstPage.name}`).count()) > 0
    );
    check('"All Workspaces" is hidden while actively searching (search mode)', (await page.locator("text=All Workspaces").count()) === 0);

    console.log("\nClearing search restores the initial list...\n");
    await searchInput.fill("");
    await page.waitForFunction(
      () => !!document.querySelector('[role="menu"]') && document.body.innerText.includes("All Workspaces"),
      undefined,
      { timeout: 5000 }
    ).catch(() => {});
    check('Clearing search restores "All Workspaces"', (await page.locator("text=All Workspaces").count()) > 0);

    console.log("\nSearching a term with zero matches shows the empty state...\n");
    await searchInput.fill(`nonexistent-${RUN_ID}-zzz`);
    await page.waitForFunction(
      () => document.body.innerText.includes("No workspaces found"),
      undefined,
      { timeout: 5000 }
    ).catch(() => {});
    check('No-match search shows "No workspaces found"', (await page.locator("text=No workspaces found").count()) > 0);

    console.log("\nSearching again and selecting the beyond-page department switches the active workspace...\n");
    await searchInput.fill(beyondFirstPage.name);
    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      beyondFirstPage.name,
      { timeout: 5000 }
    ).catch(() => {});
    await page.locator(`[role="menuitem"]:has-text("${beyondFirstPage.name}")`).first().click();
    await page.waitForFunction(
      (name) => document.body.innerText.includes(name),
      beyondFirstPage.name,
      { timeout: 8000 }
    ).catch(() => {});

    check("Dropdown closed after selecting a workspace", (await trigger.getAttribute("data-state")) === "closed");
    check(
      "Trigger now shows the newly-selected (previously beyond-page) workspace name",
      (await trigger.evaluate((el) => el.textContent || "")).includes(beyondFirstPage.name)
    );

    console.log("\nReopening confirms the selection persisted and is included in the list...\n");
    await trigger.click();
    await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 }).catch(() => {});
    check(
      "Newly-selected workspace shows a check mark / is present in the reopened list even though it's outside the initial alphabetical page",
      (await page.locator(`[role="menuitem"]:has-text("${beyondFirstPage.name}")`).count()) > 0
    );
    await page.keyboard.press("Escape");

    console.log("\nConsole and network error summary...\n");
    check("Zero unexpected console errors", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    if (departmentIds.length > 0) {
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
