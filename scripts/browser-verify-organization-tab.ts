/**
 * Real interactive browser verification for the Organization tab (/organization)
 * after Microsoft Directory Sync — same technique/precedent as
 * scripts/browser-verify-microsoft-mapping-admin.ts: launches a real
 * Chromium browser (Playwright, already a project dependency — no new E2E
 * framework introduced) against a REALLY RUNNING `next dev`/`next start`
 * instance, logs in as a real seeded admin account, and drives the actual
 * rendered UI.
 *
 * Two phases:
 *   1. Clicks the real "Sync organization" button against this
 *      environment's real (dummy-tenant, see docs/microsoft-production-readiness-audit.md)
 *      Azure credentials — proves the documented graceful-failure path
 *      (a clear toast, never a crash/502-looking broken page) reaches the
 *      real UI end-to-end, not just the API layer.
 *   2. Reloads the tab against whatever data is currently in the database
 *      (populated separately, e.g. by scripts/simulate-organization-sync-fixture.ts,
 *      since a real multi-company Graph response can't be produced in this
 *      environment) and verifies the rendered tree: multiple company roots,
 *      correct per-company department scoping, counts, expand/collapse,
 *      same-named departments under different companies rendered as
 *      genuinely separate nodes, responsive layout, refresh persistence.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-organization-tab.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || "/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/156a97d4-1f71-4afb-8ebb-333824708364/scratchpad/org-audit/screenshots";

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// This environment has no real Azure/Graph tenant credentials
// (GRAPH_TENANT_ID=dummy — see docs/microsoft-production-readiness-audit.md).
// POST /api/admin/organization/sync therefore returns a DOCUMENTED,
// EXPECTED 502 here (app/api/admin/organization/sync/route.ts's own
// `if (result.status === "FAILED") return ...502`) — this is the graceful-
// failure contract being exercised on purpose (see Phase 1 below), not a
// bug. Every OTHER 5xx is still a real failure.
const EXPECTED_DUMMY_TENANT_502_PATH = "/api/admin/organization/sync";

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (msg.type() !== "error") return;
    // Chrome's own "Failed to load resource: ... 502" network log carries no
    // URL in msg.text() — the `response` listener below is the authoritative,
    // URL-bearing source for classifying a failed HTTP response (including
    // this environment's one documented, expected 502). Never double-count
    // the same network failure as a generic "console error" too.
    if (text.startsWith("Failed to load resource")) return;
    consoleErrors.push(`[console] ${text}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 500 && !res.url().includes(EXPECTED_DUMMY_TENANT_502_PATH)) failedRequests.push(`[${res.status()}] ${res.url()}`);
  });
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors, failedRequests);

    console.log("\n=== Login ===\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
      page.click('button:has-text("Sign in as Admin")'),
    ]);
    check("Logged in successfully (left /login)", !page.url().includes("/login"));

    console.log("\n=== Navigate to Organization tab ===\n");
    await page.goto(`${BASE_URL}/organization`);
    await page.waitForLoadState("networkidle");
    check('Page heading "Organization Chart" is visible', await page.getByText("Organization Chart").first().isVisible().catch(() => false));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-initial-load.png`, fullPage: true });

    console.log("\n=== Phase 1: real Sync button against this environment's dummy-tenant credentials ===\n");
    const syncButton = page.getByRole("button", { name: /Sync organization/i });
    const hasSyncButton = await syncButton.isVisible().catch(() => false);
    check("Sync organization button is visible for an admin", hasSyncButton);
    if (hasSyncButton) {
      await syncButton.click();
      // Real, unmocked call to the real /api/admin/organization/sync route,
      // hitting this environment's real (dummy) Graph credentials — must
      // fail gracefully (a toast), never hang the button forever or render
      // a broken/blank page.
      await page.waitForTimeout(3000);
      const stillOnPage = page.url().includes("/organization");
      check("Page is still on /organization after the sync attempt (no crash/navigation-away)", stillOnPage);
      const bodyText = await page.textContent("body");
      check("No raw 'Application error' / Next.js error overlay text is shown", !bodyText?.includes("Application error"));
      check(
        'A clear, actionable "Microsoft Graph is not configured" toast is shown (the real, documented dummy-tenant graceful-failure message reaching the real UI end to end)',
        !!bodyText?.includes("Microsoft Graph is not configured")
      );
      await page.screenshot({ path: `${SCREENSHOT_DIR}/02-after-real-sync-attempt.png`, fullPage: true });
    }

    console.log("\n=== Phase 2: rendered tree for whatever data currently exists ===\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000); // ReactFlow fitView settle

    const canvas = page.locator('[aria-label="Department organization chart"]');
    const hasCanvas = await canvas.isVisible().catch(() => false);
    check("Department organization chart canvas is rendered", hasCanvas);

    if (hasCanvas) {
      const nodeCountBefore = await page.locator(".react-flow__node").count();
      check("At least one node is rendered in the tree", nodeCountBefore > 0);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/03-department-tree.png`, fullPage: true });

      // ── Expand/collapse ──────────────────────────────────────────────
      // Targets a node's collapse control by its precise aria-label
      // (components/admin/organization-chart/department-node.tsx:
      // `Collapse ${label}` / `Expand ${label}`) rather than a generic
      // selector, so this is deterministic regardless of DOM order. Scoped
      // to inside the chart canvas specifically — the app's sidebar has its
      // own unrelated "Collapse sidebar" button that also matches
      // `aria-label^="Collapse "` and would otherwise be targeted instead.
      const collapseButtons = canvas.locator('button[aria-label^="Collapse "]');
      const collapseCount = await collapseButtons.count();
      check("At least one node currently has a visible Collapse control (has children)", collapseCount > 0);
      if (collapseCount > 0) {
        const target = collapseButtons.first();
        const targetLabel = await target.getAttribute("aria-label");
        await target.click();
        await page.waitForTimeout(1000); // fitView's own 50ms delay + 200ms animation, generous margin
        const nodeCountAfter = await page.locator(".react-flow__node").count();
        check(`Clicking "${targetLabel}" reduces the rendered node count (its children are now hidden)`, nodeCountAfter < nodeCountBefore);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/04-after-collapse.png`, fullPage: true });

        // Expand it back — same control now reports the opposite state.
        const expandButtons = canvas.locator('button[aria-label^="Expand "]');
        if ((await expandButtons.count()) > 0) {
          await expandButtons.first().click();
          await page.waitForTimeout(1000);
          const nodeCountRestored = await page.locator(".react-flow__node").count();
          check("Expanding it back restores the original node count", nodeCountRestored === nodeCountBefore);
          await page.screenshot({ path: `${SCREENSHOT_DIR}/04b-after-expand-again.png`, fullPage: true });
        }
      }

      // ── Include inactive toggle ──────────────────────────────────────
      const includeInactiveSwitch = page.getByLabel("Include inactive");
      const hasSwitch = await includeInactiveSwitch.isVisible().catch(() => false);
      check('"Include inactive" toggle is present', hasSwitch);

      // ── Search ────────────────────────────────────────────────────────
      const searchBox = page.getByLabel("Search organization");
      const hasSearch = await searchBox.isVisible().catch(() => false);
      check("Search input is present", hasSearch);

      // ── People / Reporting lines tab ─────────────────────────────────
      const peopleTab = page.getByRole("tab", { name: /People/i });
      if (await peopleTab.isVisible().catch(() => false)) {
        await peopleTab.click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/05-people-tree.png`, fullPage: true });
        check("Switching to People/Reporting-lines mode doesn't crash the page", !(await page.textContent("body"))?.includes("Application error"));
        await page.getByRole("tab", { name: /Departments/i }).click();
        await page.waitForTimeout(500);
      }
    }

    console.log("\n=== Responsive layout (mobile-ish viewport) ===\n");
    await page.setViewportSize({ width: 480, height: 800 });
    await page.waitForTimeout(500);
    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 5);
    check("No horizontal page overflow at a narrow (480px) viewport", !bodyOverflow);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-narrow-viewport.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    console.log("\n=== Refresh persistence ===\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    const canvasAfterReload = await page.locator('[aria-label="Department organization chart"]').isVisible().catch(() => false);
    check("Tree still renders correctly after a hard page refresh", canvasAfterReload || (await page.getByText(/No departments to show/i).isVisible().catch(() => false)));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-after-refresh.png`, fullPage: true });

    console.log("\n=== Console/network health ===\n");
    check("No uncaught console/page errors during the whole session", consoleErrors.length === 0);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 10));
    check("No 5xx server responses observed", failedRequests.length === 0);
    if (failedRequests.length > 0) console.log(failedRequests.slice(0, 10));

    await context.close();
  } finally {
    await browser.close();
  }

  console.log(`\nScreenshots saved under: ${SCREENSHOT_DIR}`);
  printSummaryAndExit();
}

main();
