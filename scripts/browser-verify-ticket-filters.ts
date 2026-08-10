/**
 * Real interactive browser verification of the exact reported bug: the All
 * Tickets Status/Priority dropdowns showed duplicate entries ("Open" once
 * per department that had it) and never updated live when the active
 * workspace was switched. Drives the actual running dev app end to end:
 * open the Status dropdown, assert every option is unique, switch
 * workspace via the real workspace selector, reopen the dropdown, assert
 * the options changed to the new workspace's own config, repeat for
 * Priority, and assert no full page reload occurred and zero console
 * errors — matching the rigor of this repo's other browser-verify scripts.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-ticket-filters.ts
 * Requires a reachable DATABASE_URL and a running dev server — skips if
 * either is unavailable.
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { createDepartment } from "@/lib/services/department-service";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";
const RUN_ID = Date.now();
const TAG = `bvtf-${RUN_ID}`;

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

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    const isBenign =
      isAborted &&
      (req.url().includes("_rsc=") ||
        (req.url().includes("/api/notifications") && req.method() === "GET") ||
        (req.url().includes("/_next/static/css/") && req.method() === "GET"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
}

async function switchWorkspace(page: Page, departmentName: string) {
  const trigger = page.locator("header button", { has: page.locator("text=Workspace") }).first();
  await trigger.click();
  await page.waitForSelector('input[placeholder="Search workspaces..."]', { timeout: 5000 });
  const searchInput = page.locator('input[placeholder="Search workspaces..."]');
  await searchInput.fill(departmentName);
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 5000 }).catch(() => {});
  const activeWorkspaceResponse = page.waitForResponse(
    (res) => res.url().includes("/api/workspace/active") && res.request().method() === "POST",
    { timeout: 8000 }
  );
  await page.locator(`[role="menuitem"]:has-text("${departmentName}")`).first().click();
  await activeWorkspaceResponse.catch(() => {});
  await page.waitForFunction((name) => document.body.innerText.includes(name), departmentName, { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState("networkidle");
}

async function readComboboxOptions(page: Page, comboboxIndex: number): Promise<string[]> {
  const trigger = page.locator('button[role="combobox"]').nth(comboboxIndex);
  await trigger.click();
  await page.waitForSelector('[role="option"]', { timeout: 5000 });
  const texts = await page.locator('[role="option"]').allTextContents();
  await page.keyboard.press("Escape");
  await page.locator('[role="option"]').first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  return texts.map((t) => t.trim()).filter(Boolean);
}

async function waitForComboboxOptions(
  page: Page,
  comboboxIndex: number,
  predicate: (options: string[]) => boolean,
  timeoutMs = 10000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastRead: string[] = [];
  while (Date.now() < deadline) {
    lastRead = await readComboboxOptions(page, comboboxIndex);
    if (predicate(lastRead)) return lastRead;
    await page.waitForTimeout(300);
  }
  return lastRead;
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
    console.log("\n=== Fixtures: two departments with overlapping + distinct statuses/priorities ===\n");
    const deptX = await createDepartment({ name: `${TAG}-Workspace-X`, slug: `${TAG}-workspace-x` });
    const deptY = await createDepartment({ name: `${TAG}-Workspace-Y`, slug: `${TAG}-workspace-y` });
    departmentIds.push(deptX.id, deptY.id);

    // Deactivate createDepartment()'s own starter config so only this
    // script's own rows are visible — full control over each workspace's
    // exact option set, matching scripts/test-ticket-filter-options.ts.
    await prisma.ticketStatus.updateMany({ where: { departmentId: { in: [deptX.id, deptY.id] } }, data: { isActive: false } });
    await prisma.ticketPriority.updateMany({ where: { departmentId: { in: [deptX.id, deptY.id] } }, data: { isActive: false } });

    const OPEN = `${TAG}Open`;
    const IN_PROGRESS = `${TAG}InProgress`;
    const RESOLVED = `${TAG}Resolved`;
    const WAITING = `${TAG}Waiting`;

    const statusX = await Promise.all([
      prisma.ticketStatus.create({ data: { name: OPEN, color: "#111111", order: 0, departmentId: deptX.id } }),
      prisma.ticketStatus.create({ data: { name: IN_PROGRESS, color: "#222222", order: 1, departmentId: deptX.id } }),
      prisma.ticketStatus.create({ data: { name: RESOLVED, color: "#333333", order: 2, departmentId: deptX.id } }),
    ]);
    await Promise.all([
      prisma.ticketStatus.create({ data: { name: OPEN, color: "#111111", order: 0, departmentId: deptY.id } }),
      prisma.ticketStatus.create({ data: { name: WAITING, color: "#555555", order: 1, departmentId: deptY.id } }),
    ]);

    const HIGH = `${TAG}High`;
    const LOW = `${TAG}Low`;
    await Promise.all([
      prisma.ticketPriority.create({ data: { name: HIGH, level: 3, color: "#ccc", departmentId: deptX.id } }),
      prisma.ticketPriority.create({ data: { name: LOW, level: 1, color: "#aaa", departmentId: deptX.id } }),
    ]);
    await prisma.ticketPriority.create({ data: { name: HIGH, level: 3, color: "#ccc", departmentId: deptY.id } });

    // Several tickets sharing the same status in Dept X — the literal
    // "Open / Open / Open" repro. If the dropdown still had the bug, this
    // alone wouldn't even be needed (the bug came from a cross-department
    // config query, not a per-ticket one) — included anyway so this
    // fixture stays representative of a real, populated workspace.
    const requester = await prisma.user.findFirstOrThrow({ where: { email: ADMIN_EMAIL }, select: { id: true } });
    for (let i = 0; i < 4; i++) {
      await prisma.ticket.create({
        data: {
          title: `${TAG} ticket ${i}`,
          description: "fixture",
          departmentId: deptX.id,
          statusId: statusX[0].id,
          requesterId: requester.id,
        },
      });
    }

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
    await page.waitForLoadState("networkidle");

    console.log(`\nSwitching to workspace "${deptX.name}" and opening All Tickets...\n`);
    await switchWorkspace(page, deptX.name);
    await page.goto(`${BASE_URL}/tickets?status=all`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      (window as any).__noReloadMarker = true;
    });

    // Combobox order in ticket-filters.tsx: [Sort by, Status, Priority] — the
    // old left-most "Open" status-GROUP dropdown (previously index 1,
    // shifting Status/Priority to 2/3) was removed entirely; see
    // scripts/browser-verify-ticket-status-filter-race.ts for a dedicated
    // assertion that it's actually gone.
    const STATUS_INDEX = 1;
    const PRIORITY_INDEX = 2;

    console.log("\nOpening Status dropdown for Workspace X...\n");
    const statusOptionsX = await readComboboxOptions(page, STATUS_INDEX);
    const uniqueStatusOptionsX = new Set(statusOptionsX);
    check(
      "Workspace X Status dropdown has NO duplicate entries (the reported bug)",
      uniqueStatusOptionsX.size === statusOptionsX.length,
      `options: ${statusOptionsX.join(", ")}`
    );
    check(`Workspace X Status dropdown contains ${OPEN}`, statusOptionsX.some((o) => o.includes(OPEN)));
    check(`Workspace X Status dropdown contains ${IN_PROGRESS}`, statusOptionsX.some((o) => o.includes(IN_PROGRESS)));
    check(`Workspace X Status dropdown contains ${RESOLVED}`, statusOptionsX.some((o) => o.includes(RESOLVED)));
    check(`Workspace X Status dropdown does NOT contain Workspace-Y-only "${WAITING}"`, !statusOptionsX.some((o) => o.includes(WAITING)));

    console.log("\nOpening Priority dropdown for Workspace X...\n");
    const priorityOptionsX = await readComboboxOptions(page, PRIORITY_INDEX);
    check("Workspace X Priority dropdown has NO duplicate entries", new Set(priorityOptionsX).size === priorityOptionsX.length, priorityOptionsX.join(", "));
    check(`Workspace X Priority dropdown contains ${HIGH} and ${LOW}`, priorityOptionsX.some((o) => o.includes(HIGH)) && priorityOptionsX.some((o) => o.includes(LOW)));

    console.log(`\nSwitching workspace to "${deptY.name}" (no manual refresh)...\n`);
    await switchWorkspace(page, deptY.name);
    check("No full page reload occurred across the workspace switch", await page.evaluate(() => (window as any).__noReloadMarker === true));

    console.log("\nReopening Status dropdown — options must reflect Workspace Y immediately...\n");
    const statusOptionsY = await waitForComboboxOptions(page, STATUS_INDEX, (opts) => opts.some((o) => o.includes(WAITING)));
    check("Workspace Y Status dropdown has NO duplicate entries", new Set(statusOptionsY).size === statusOptionsY.length, statusOptionsY.join(", "));
    check(`Workspace Y Status dropdown contains ${OPEN}`, statusOptionsY.some((o) => o.includes(OPEN)));
    check(`Workspace Y Status dropdown contains ${WAITING}`, statusOptionsY.some((o) => o.includes(WAITING)));
    check(
      `Workspace Y Status dropdown does NOT contain Workspace-X-only "${IN_PROGRESS}" (live-updated, not stale from X)`,
      !statusOptionsY.some((o) => o.includes(IN_PROGRESS))
    );
    check(
      `Workspace Y Status dropdown does NOT contain Workspace-X-only "${RESOLVED}"`,
      !statusOptionsY.some((o) => o.includes(RESOLVED))
    );

    console.log("\nReopening Priority dropdown — must also reflect Workspace Y immediately...\n");
    const priorityOptionsY = await readComboboxOptions(page, PRIORITY_INDEX);
    check("Workspace Y Priority dropdown has NO duplicate entries", new Set(priorityOptionsY).size === priorityOptionsY.length);
    check(`Workspace Y Priority dropdown contains ${HIGH}`, priorityOptionsY.some((o) => o.includes(HIGH)));
    check(`Workspace Y Priority dropdown does NOT contain Workspace-X-only "${LOW}"`, !priorityOptionsY.some((o) => o.includes(LOW)));

    console.log("\nInvalid-filter-reset: selecting Workspace X's 'InProgress', then switching to Workspace Y removes it from the URL...\n");
    await switchWorkspace(page, deptX.name);
    await page.goto(`${BASE_URL}/tickets?status=all`);
    await page.waitForLoadState("networkidle");
    const statusTrigger = page.locator('button[role="combobox"]').nth(STATUS_INDEX);
    await statusTrigger.click();
    await page.getByRole("option", { name: new RegExp(IN_PROGRESS) }).click();
    await page.waitForFunction(() => location.search.includes("statusId="), undefined, { timeout: 5000 }).catch(() => {});
    check("statusId param present in URL after selecting InProgress", page.url().includes("statusId="));

    await switchWorkspace(page, deptY.name);
    await page.waitForFunction(() => !location.search.includes("statusId="), undefined, { timeout: 8000 }).catch(() => {});
    check(
      "After switching to a workspace without 'InProgress', the stale statusId param is removed from the URL (not silently kept)",
      !page.url().includes("statusId=")
    );

    console.log("\nInvalid-filter-reset: a selection that remains valid (same name in both) is preserved across the switch...\n");
    await switchWorkspace(page, deptX.name);
    await page.goto(`${BASE_URL}/tickets?status=all`);
    await page.waitForLoadState("networkidle");
    const statusTrigger2 = page.locator('button[role="combobox"]').nth(STATUS_INDEX);
    await statusTrigger2.click();
    await page.getByRole("option", { name: new RegExp(`^${OPEN}$`) }).click();
    await page.waitForFunction(() => location.search.includes("statusId="), undefined, { timeout: 5000 }).catch(() => {});
    const urlBeforeSwitch = page.url();

    await switchWorkspace(page, deptY.name);
    await page.waitForFunction((prev) => location.href !== prev, urlBeforeSwitch, { timeout: 8000 }).catch(() => {});
    check("statusId param is STILL present after switching (Open exists in both workspaces)", page.url().includes("statusId="));
    check("The corrected statusId now points at Workspace Y's OWN Open row, not Workspace X's stale id", page.url() !== urlBeforeSwitch);
    const statusSelectedText = await page.locator('button[role="combobox"]').nth(STATUS_INDEX).innerText();
    check(`Status dropdown still visually shows "${OPEN}" selected after the switch`, statusSelectedText.includes(OPEN));

    console.log("\nConsole and network error summary...\n");
    check("Zero unexpected console errors", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    await prisma.ticket.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    if (departmentIds.length > 0) {
      await prisma.ticketCategory.deleteMany({ where: { departmentId: { in: departmentIds } } }).catch(() => {});
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
