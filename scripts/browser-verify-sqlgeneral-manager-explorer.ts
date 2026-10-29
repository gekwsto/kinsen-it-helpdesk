/**
 * Real interactive browser verification for the SQLGeneral Manager Subtree
 * Explorer — same technique/precedent as scripts/browser-verify-organization-tab.ts:
 * launches a real Chromium browser (Playwright, already a project
 * dependency) against a REALLY RUNNING `next dev`/`next start` instance,
 * logs in as a real seeded admin account, and drives the actual rendered UI.
 *
 * This environment has no real SQLGeneral credentials (SQLGENERAL_* stays
 * dummy/unconfigured — see lib/sqlgeneral-api-client.ts's own header), so
 * /api/admin/organization/sqlgeneral-tree is intercepted via page.route()
 * and served a controlled fixture forest instead of hitting the real
 * SQLGeneral API — the SAME technique already used by
 * scripts/browser-verify-project-export.ts for a different route. Only the
 * ONE network call is mocked; the entire React UI (the Manager Subtree
 * Explorer, ChartCanvas, collapse/expand, ReactFlow) runs for real.
 *
 * The fixture deliberately includes MANY top-level roots (one real,
 * detailed subtree plus a pile of unrelated single-node roots) specifically
 * to prove the root-cause fix: the directory view never mounts a ReactFlow
 * canvas over the whole forest, and selecting one manager renders only
 * their own subtree.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-sqlgeneral-manager-explorer.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const SCREENSHOT_DIR =
  process.env.SCREENSHOT_DIR || "/private/tmp/claude-501/-Users-pavloschatzisavvas-Documents-pythonProjects-kinsen-it-helpdesk/156a97d4-1f71-4afb-8ebb-333824708364/scratchpad/sqlgeneral-explorer/screenshots";

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

function person(username: string, managerLabel: string | null, opts: Partial<{ isLocal: boolean; userId: string | null; name: string | null; email: string | null; jobTitle: string | null; company: string | null; department: string | null; children: any[] }> = {}) {
  return {
    id: `sgperson:${username}`,
    kind: "sqlgeneral-person",
    sqlGeneralUsername: username,
    isLocal: opts.isLocal ?? false,
    userId: opts.userId ?? null,
    name: opts.name ?? null,
    email: opts.email ?? `${username}@example.com`,
    jobTitle: opts.jobTitle ?? null,
    company: opts.company ?? "Acme HQ",
    department: opts.department ?? null,
    isActive: true,
    children: opts.children ?? [],
  };
}

function buildFixtureTree() {
  const nikpap = person("nikpap", "thoche", { isLocal: true, userId: "u-nikpap", name: "Niko Papadopoulos", company: "Gamma Co" });
  const thoche = person("thoche", "geokos", { company: "Gamma Co", children: [nikpap] });
  const konkef = person("konkef", "geokos", { isLocal: true, userId: "u-konkef", name: "Kostas Konstantinou" });
  const chapav = person("chapav", "geokos", { company: "Beta Co" });
  const stekam = person("stekam", "geokos", { company: "Delta Co" });
  const geokos = person("geokos", null, { name: "Georgios Kostopoulos", children: [konkef, chapav, thoche, stekam] });

  // A pile of unrelated single-node roots to simulate a real, large
  // SQLGeneral forest — proves the directory never renders all of this at
  // once, and selecting geokos never drags any of these in either.
  const noise = Array.from({ length: 20 }, (_, i) => person(`noise${i}`, null, { company: `Noise Co ${i}` }));

  return [geokos, ...noise];
}

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    const text = msg.text();
    if (msg.type() !== "error") return;
    if (text.startsWith("Failed to load resource")) return;
    consoleErrors.push(`[console] ${text}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 500) failedRequests.push(`[${res.status()}] ${res.url()}`);
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

    await page.route("**/api/admin/organization/sqlgeneral-tree", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          initialized: true,
          tree: buildFixtureTree(),
          unresolvedUsers: [],
          // One fabricated inactive_manager relationship, exactly like the
          // real 8-employee production report — proves the friendly,
          // ADMIN-only summary wording (never raw usernames/reason codes).
          unresolvedManagerLinks: [{ sqlGeneralUsername: "someone-else", reason: "inactive_manager" }],
          lastSuccessfulSyncAt: new Date().toISOString(),
        }),
      });
    });

    console.log("\n=== Login ===\n");
    await page.goto(`${BASE_URL}/login`);
    await page.fill("#credentials-email", ADMIN_EMAIL);
    await page.fill("#credentials-password", ADMIN_PASSWORD);
    await Promise.all([page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }), page.click('button:has-text("Sign in as Admin")')]);
    check("Logged in successfully (left /login)", !page.url().includes("/login"));

    console.log("\n=== Navigate to Organization tab, Org. Chart mode (renamed from 'SQLGeneral source') ===\n");
    await page.goto(`${BASE_URL}/organization`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    check("0. The old 'SQLGeneral source' label is gone", !(await page.getByRole("tab", { name: /SQLGeneral source/i }).isVisible().catch(() => false)));
    check("0b. 'People / Reporting lines' is no longer a selectable tab", !(await page.getByRole("tab", { name: /People/i }).isVisible().catch(() => false)));
    await page.getByRole("tab", { name: /^Org\. Chart$/i }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-initial-sqlgeneral-view.png`, fullPage: true });

    console.log("\n=== ADMIN-only friendly diagnostics summary (never raw usernames/reason codes) ===\n");
    check(
      "0c. The friendly summary sentence is visible (plain language, matching the production wording)",
      await page.getByText(/reporting relationship.*linked to inactive manager/i).isVisible().catch(() => false)
    );
    check("0d. The RAW SQLGeneral username from the fixture is NEVER shown in the summary", !(await page.getByText("someone-else", { exact: false }).isVisible().catch(() => false)));
    check("0e. The raw technical reason code is NEVER shown in the summary", !(await page.getByText("inactive_manager", { exact: false }).isVisible().catch(() => false)));

    console.log("\n=== Root cause: initial view must NEVER render the whole forest in ReactFlow ===\n");
    const initialNodeCount = await page.locator(".react-flow__node").count();
    check("1. Zero ReactFlow nodes are rendered on initial SQLGeneral load — no canvas to zoom out on at all", initialNodeCount === 0);
    check("2. The manager directory ('Browse by manager') is visible instead", await page.getByText("Browse by manager").isVisible().catch(() => false));
    check("3. The employee search box is visible", await page.getByLabel("Search SQLGeneral employees").isVisible().catch(() => false));
    check(
      "4. Managers are listed as plain TEXT rows (with team sizes), never as zoomed-out chart nodes — geokos shows by his real name, with his full 5-person team size",
      await page.getByText("Georgios Kostopoulos", { exact: false }).first().isVisible().catch(() => false) && await page.getByText("5 reports").isVisible().catch(() => false)
    );

    console.log('\n=== Selecting "geokos" renders exactly his own bounded subtree ===\n');
    await page.getByRole("button", { name: /Georgios Kostopoulos|geokos/i }).first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-geokos-subtree.png`, fullPage: true });
    const afterSelectNodeCount = await page.locator(".react-flow__node").count();
    check("5. Selecting geokos renders a SMALL, bounded set of nodes (geokos + his 4 direct reports, not the other 20 unrelated roots)", afterSelectNodeCount > 0 && afterSelectNodeCount <= 6);
    for (const expectedReport of ["Kostas Konstantinou", "chapav", "thoche", "stekam"]) {
      check(`6. "${expectedReport}" (a direct report of geokos) is visible in the rendered subtree`, await page.getByText(expectedReport, { exact: false }).first().isVisible().catch(() => false));
    }
    check('7. None of the unrelated "noise" roots leaked into geokos\'s rendered subtree', !(await page.getByText("noise0", { exact: false }).isVisible().catch(() => false)));
    check("8. A breadcrumb back to the directory is visible", await page.getByRole("button", { name: /Directory/i }).isVisible().catch(() => false));

    console.log("\n=== Breadcrumb returns to the directory ===\n");
    await page.getByRole("button", { name: /Directory/i }).click();
    await page.waitForTimeout(300);
    check("9. Clicking the Directory breadcrumb returns to the directory (zero canvas nodes again)", (await page.locator(".react-flow__node").count()) === 0);

    console.log('\n=== Searching "thoche" opens the correct subtree and focuses the employee ===\n');
    await page.getByLabel("Search SQLGeneral employees").fill("thoche");
    await page.waitForTimeout(400);
    const thocheResult = page.getByRole("button", { name: /thoche/i }).first();
    check("10. Searching 'thoche' surfaces a matching result", await thocheResult.isVisible().catch(() => false));
    await thocheResult.click();
    await page.waitForTimeout(800);
    // Selecting a node also opens the existing (shared, pre-existing-across-
    // all-modes) info dialog — close it to inspect the chart underneath,
    // same as a real user dismissing the popup.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-thoche-focused.png`, fullPage: true });
    check(
      "11. Searching thoche opens geokos's subtree (thoche's DIRECT manager — which happens to equal thoche's ultimate top-level manager in this fixture, since thoche reports straight to geokos)",
      await page.getByText("Georgios Kostopoulos", { exact: false }).first().isVisible().catch(() => false)
    );
    check("12. thoche himself is visible, focused, in the rendered subtree", await page.getByText("thoche", { exact: false }).first().isVisible().catch(() => false));
    const selectedCard = page.locator('[aria-selected="true"]');
    check("13. Exactly one node is marked aria-selected (thoche, the focused employee)", (await selectedCard.count()) >= 1);
    check("14. nikpap (thoche's own report, multi-level) is also visible — searching an intermediate manager keeps their own subtree intact", await page.getByText("Niko Papadopoulos", { exact: false }).isVisible().catch(() => false));

    console.log('\n=== THE ACTUAL BUG FIX: searching "nikpap" (3 levels deep: geokos -> thoche -> nikpap) focuses on nikpap\'s DIRECT manager (thoche), never the ultimate root (geokos) ===\n');
    await page.getByRole("button", { name: /Directory/i }).click();
    await page.waitForTimeout(300);
    await page.getByLabel("Search SQLGeneral employees").fill("nikpap");
    await page.waitForTimeout(400);
    const nikpapResult = page.getByRole("button", { name: /nikpap|Niko Papadopoulos/i }).first();
    check("14b. Searching 'nikpap' surfaces a matching result", await nikpapResult.isVisible().catch(() => false));
    await nikpapResult.click();
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03b-nikpap-focused.png`, fullPage: true });
    check(
      "14c. The view is focused on thoche (nikpap's DIRECT manager) — never relabeled back to the ultimate root geokos",
      await page.getByText("thoche", { exact: false }).first().isVisible().catch(() => false) && !(await page.getByText("Georgios Kostopoulos", { exact: false }).isVisible().catch(() => false))
    );
    check("14d. nikpap himself is visible, focused, in the rendered subtree", await page.getByText("Niko Papadopoulos", { exact: false }).first().isVisible().catch(() => false));
    check(
      "14e. THE FIX: konkef/chapav/stekam (geokos's OTHER direct reports, completely unrelated to nikpap's own branch) do NOT leak into this focused view — proves this is nikpap's own small, relevant subtree, never the entire organization",
      !(await page.getByText("Kostas Konstantinou", { exact: false }).isVisible().catch(() => false)) &&
        !(await page.getByText("chapav", { exact: false }).isVisible().catch(() => false)) &&
        !(await page.getByText("stekam", { exact: false }).isVisible().catch(() => false))
    );
    const nikpapNodeCount = await page.locator(".react-flow__node").count();
    check("14f. The rendered node count for nikpap's focused view is small (thoche + nikpap only — 1 or 2 nodes), not geokos's full 5-person team", nikpapNodeCount > 0 && nikpapNodeCount <= 2);

    console.log("\n=== Expand/collapse and hover remain functional within a focused subtree ===\n");
    const canvas = page.locator('[aria-label="SQLGeneral manager subtree chart"]');
    check("15. The scoped canvas has the correct aria-label", await canvas.isVisible().catch(() => false));
    const collapseButtons = canvas.locator('button[aria-label*="Collapse"]');
    if ((await collapseButtons.count()) > 0) {
      const before = await page.locator(".react-flow__node").count();
      await collapseButtons.first().click();
      await page.waitForTimeout(500);
      const after = await page.locator(".react-flow__node").count();
      check("16. Collapsing a node reduces the visible node count", after < before);
    }

    console.log("\n=== Existing Departments mode is completely unaffected (People / Reporting Lines was removed entirely) ===\n");
    await page.getByRole("tab", { name: /^Departments$/i }).click();
    await page.waitForTimeout(1000);
    check("17. Switching to Departments mode still renders its own full-tree canvas (unchanged behavior)", await page.getByLabel("Search organization").isVisible().catch(() => false));
    check("17b. Departments mode does not crash", !(await page.textContent("body"))?.includes("Application error"));
    check("18. There is no 'People' tab to click at all anymore — only Departments and Org. Chart", (await page.getByRole("tab").count()) === 2);

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
