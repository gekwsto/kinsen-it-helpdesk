/**
 * Real interactive browser verification that Activities filters update the
 * displayed results IMMEDIATELY, without a manual page refresh — the actual
 * bug report: server-side query logic was already proven correct
 * (scripts/test-activity-filters.ts inspects the Server Component's
 * returned element tree directly), but that test never mounts/hydrates the
 * CLIENT component tree, so it could never have caught the real root cause:
 * components/activities/activity-list.tsx copied its `activities` prop into
 * local useState ONCE on mount and never re-synced it when the Server
 * Component re-ran with fresh (filtered) data on a searchParams navigation
 * — this script proves the fix by actually clicking the filter controls in
 * a real browser and asserting the DOM updates, with no full page reload in
 * between (tracked via a marker that only a hard navigation would clear).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-activity-filters-live-update.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { createDepartment } from "@/lib/services/department-service";

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

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) => {
    const isAborted = req.failure()?.errorText === "net::ERR_ABORTED";
    // Both previously-confirmed benign patterns from this repo's other
    // browser-verify scripts: an in-flight RSC fetch aborted by the next
    // client navigation, and the notifications-bell poll aborted the same
    // way by a route change mid-request — neither is a real failure.
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
  const activityIds: string[] = [];
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const dept = await createDepartment({ name: `Browser Filter Dept ${RUN_ID}`, slug: `browser-filter-dept-${RUN_ID}` });
    departmentIds.push(dept.id);

    const now = new Date();
    const past = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const future = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000);

    // Non-terminal, past due -> genuinely overdue per the app's own
    // definition (lib/overdue.ts): past due date AND not terminal.
    const overdueActivity = await prisma.projectActivity.create({
      data: { title: `Browser Overdue Activity ${RUN_ID}`, status: ActivityStatus.IN_PROGRESS, priority: ActivityPriority.HIGH, departmentId: dept.id, dueDate: past },
    });
    // Not overdue (future due date), not completed.
    const notOverdueActivity = await prisma.projectActivity.create({
      data: { title: `Browser Not Overdue Activity ${RUN_ID}`, status: ActivityStatus.TODO, priority: ActivityPriority.LOW, departmentId: dept.id, dueDate: future },
    });
    // Terminal/completed — never counted as overdue regardless of due date.
    const completedActivity = await prisma.projectActivity.create({
      data: { title: `Browser Completed Activity ${RUN_ID}`, status: ActivityStatus.COMPLETED, priority: ActivityPriority.MEDIUM, departmentId: dept.id, dueDate: past },
    });
    activityIds.push(overdueActivity.id, notOverdueActivity.id, completedActivity.id);

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

    console.log("\nNavigating to /activities?view=list (list view — easiest to assert row text against)...\n");
    await page.goto(`${BASE_URL}/activities?view=list&pageSize=100`);
    await page.waitForLoadState("networkidle");

    // A marker that only survives client-side navigation — a hard page
    // reload/full navigation always re-evaluates the page script from
    // scratch, resetting window state. If this is still `true` after every
    // filter click below, we've proven no full reload happened.
    await page.evaluate(() => {
      (window as any).__noReloadMarker = true;
    });

    check("Overdue fixture activity visible with no filters applied", (await page.locator(`text=${overdueActivity.title}`).count()) > 0);
    check("Not-overdue fixture activity visible with no filters applied", (await page.locator(`text=${notOverdueActivity.title}`).count()) > 0);
    check("Completed fixture activity visible with no filters applied", (await page.locator(`text=${completedActivity.title}`).count()) > 0);

    console.log("\nClicking 'Overdue only'...\n");
    await page.click('button:has-text("Overdue only")');
    // Give the client-side navigation + RSC re-render a moment, WITHOUT
    // reloading the page ourselves — this is the exact thing under test.
    await page.waitForFunction(
      (title) => !document.body.innerText.includes(title),
      notOverdueActivity.title,
      { timeout: 8000 }
    ).catch(() => {});

    check(
      "Overdue-only filter: the overdue activity is STILL shown (no refresh needed)",
      (await page.locator(`text=${overdueActivity.title}`).count()) > 0
    );
    check(
      "Overdue-only filter: the NOT-overdue activity disappears immediately",
      (await page.locator(`text=${notOverdueActivity.title}`).count()) === 0
    );
    check(
      "Overdue-only filter: the completed (terminal) activity is excluded even though its due date is in the past",
      (await page.locator(`text=${completedActivity.title}`).count()) === 0
    );
    check("URL reflects overdue=true", page.url().includes("overdue=true"));
    check("No full page reload occurred (client-side navigation only)", await page.evaluate(() => (window as any).__noReloadMarker === true));

    console.log("\nClicking 'Overdue only' again to remove the filter...\n");
    await page.click('button:has-text("Overdue only")');
    await page.waitForFunction(
      (title) => document.body.innerText.includes(title),
      notOverdueActivity.title,
      { timeout: 8000 }
    ).catch(() => {});
    check("Un-toggling Overdue only immediately restores the not-overdue activity", (await page.locator(`text=${notOverdueActivity.title}`).count()) > 0);
    check("URL no longer has overdue=true", !page.url().includes("overdue=true"));
    check("Still no full page reload", await page.evaluate(() => (window as any).__noReloadMarker === true));

    console.log("\nChanging the Completion filter to 'Completed only'...\n");
    // shadcn/Radix Select — click the trigger, then the option. Targeted by
    // POSITION (the Completion select is structurally the first combobox in
    // the quick-filters row — Project is second, and the "advanced" panel's
    // selects are never rendered in this test since "More filters" is never
    // clicked), not by its current label text — a text-based filter breaks
    // the moment a real value ("Completed only") no longer contains the
    // word "completion" as a substring.
    const completionTrigger = page.locator('button[role="combobox"]').first();
    await completionTrigger.click();
    await page.waitForTimeout(200);
    await page.getByRole("option", { name: "Completed only" }).click();
    await page.waitForFunction(
      (title) => !document.body.innerText.includes(title),
      overdueActivity.title,
      { timeout: 8000 }
    ).catch(() => {});

    check("Completion=Completed only: the completed activity is shown", (await page.locator(`text=${completedActivity.title}`).count()) > 0);
    check("Completion=Completed only: the (non-terminal) overdue activity disappears immediately", (await page.locator(`text=${overdueActivity.title}`).count()) === 0);
    check("Completion=Completed only: the (non-terminal) not-overdue activity disappears immediately", (await page.locator(`text=${notOverdueActivity.title}`).count()) === 0);
    check("URL reflects statusGroup=completed", page.url().includes("statusGroup=completed"));
    check("Still no full page reload after Select change", await page.evaluate(() => (window as any).__noReloadMarker === true));

    console.log("\nUsing text search to find only the overdue activity by exact title...\n");
    await completionTrigger.click();
    await page.waitForTimeout(200);
    await page.getByRole("option", { name: "All completion" }).click();
    await page.waitForTimeout(300);

    const searchInput = page.locator('input[placeholder*="Search by title"]');
    await searchInput.fill(overdueActivity.title);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (title) => !document.body.innerText.includes(title),
      completedActivity.title,
      { timeout: 8000 }
    ).catch(() => {});
    check("Search: only the matching activity is shown", (await page.locator(`text=${overdueActivity.title}`).count()) > 0);
    check("Search: a non-matching activity is excluded immediately", (await page.locator(`text=${completedActivity.title}`).count()) === 0);
    check("Still no full page reload after search", await page.evaluate(() => (window as any).__noReloadMarker === true));

    console.log("\nBrowser back navigation restores the previous filter state...\n");
    await page.goBack();
    await page.waitForLoadState("networkidle");
    // React's commit of the new RSC payload can land a beat after
    // "networkidle" — wait for the actual DOM content instead of a fixed
    // delay, matching how every other step in this script already confirms
    // content, not just network state.
    await page.waitForFunction(
      (title) => document.body.innerText.includes(title),
      notOverdueActivity.title,
      { timeout: 8000 }
    ).catch(() => {});
    check(
      "Back navigation restores the un-searched, un-filtered state (all 3 fixture activities visible again)",
      (await page.locator(`text=${overdueActivity.title}`).count()) > 0 &&
        (await page.locator(`text=${notOverdueActivity.title}`).count()) > 0 &&
        (await page.locator(`text=${completedActivity.title}`).count()) > 0
    );

    console.log("\nConsole and network error summary...\n");
    check("Zero unexpected console errors", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero unexpected failed network requests", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));

    await browser.close();
  } finally {
    await prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } }).catch(() => {});
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
