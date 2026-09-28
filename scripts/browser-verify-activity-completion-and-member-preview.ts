/**
 * Real interactive browser verification (corrective follow-up) for two
 * things fixed together in the same task:
 *
 *  1. The Activity-completion checkbox on the Project detail page must
 *     never arm the global navigation-loader overlay (it's a same-page
 *     mutation, not a navigation) — clicking the checkbox root, clicking an
 *     inner icon/SVG (the Loader2 spinner shown while the request is in
 *     flight), and clicking while that spinner is rendered must all avoid
 *     it. A genuine row-link click (the Activity title, which DOES
 *     navigate) must still arm and resolve the overlay normally — proving
 *     the fix is a targeted opt-out, not a broken/disabled loader.
 *  2. MemberPreview (components/shared/member-preview.tsx) on the Project/
 *     Activity List views: keyboard-focusable, opens on focus, closes on
 *     Escape/outside click, many-member content is scrollable, and a touch
 *     tap never triggers the row's own navigation.
 *
 * Uses `playwright` directly against a live `npm run dev` server, with
 * fixture data written straight to the same database via Prisma (same
 * established pattern as scripts/browser-verify-activity-filters-live-update.ts).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-activity-completion-and-member-preview.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";
import { prisma } from "@/lib/prisma";
import { Role, AuthProvider } from "@prisma/client";
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
    const isBenign = isAborted && (req.url().includes("_rsc=") || (req.url().includes("/api/notifications") && req.method() === "GET"));
    if (!isBenign) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
}

const OVERLAY_SELECTOR = '[role="status"][aria-live="polite"]';
async function overlayIsVisible(page: Page): Promise<boolean> {
  const el = page.locator(OVERLAY_SELECTOR).first();
  const hidden = await el.getAttribute("aria-hidden");
  return hidden === "false";
}
async function pollOverlayVisible(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await overlayIsVisible(page)) return true;
    await page.waitForTimeout(30);
  }
  return false;
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", password);
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

  const deptIds: string[] = [];
  const userIds: string[] = [];
  const projectIds: string[] = [];
  const activityIds: string[] = [];

  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  try {
    const dept = await createDepartment({ name: `BV Completion ${RUN_ID}`, slug: `bv-completion-${RUN_ID}` });
    deptIds.push(dept.id);
    const admin = await prisma.user.findFirst({ where: { email: ADMIN_EMAIL } });
    if (!admin) throw new Error(`Seeded admin user ${ADMIN_EMAIL} not found — cannot proceed.`);

    const memberNames = ["Alpha One", "Bravo Two", "Charlie Three", "Delta Four", "Echo Five", "Foxtrot Six", "Golf Seven", "Hotel Eight"];
    const members = [];
    for (const name of memberNames) {
      members.push(
        await prisma.user.create({
          data: { email: `bv-${name.toLowerCase().replace(/\s+/g, "-")}-${RUN_ID}@kinsen.gr`, name, role: Role.USER, authProvider: AuthProvider.CREDENTIALS, isActive: true },
        })
      );
    }
    userIds.push(...members.map((m) => m.id));

    const project = await prisma.project.create({
      data: { title: `BV Project ${RUN_ID}`, departmentId: dept.id, ownerId: admin.id, members: { connect: members.map((m) => ({ id: m.id })) } },
    });
    projectIds.push(project.id);
    const activityToToggle = await prisma.projectActivity.create({
      data: { title: `BV Activity Toggle ${RUN_ID}`, projectId: project.id, departmentId: dept.id, status: "IN_PROGRESS", isCompleted: false, assignedUsers: { connect: members.map((m) => ({ id: m.id })) } },
    });
    const otherActivity = await prisma.projectActivity.create({
      data: { title: `BV Activity Other ${RUN_ID}`, projectId: project.id, departmentId: dept.id, status: "TODO", isCompleted: false },
    });
    activityIds.push(activityToToggle.id, otherActivity.id);

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors, failedRequests);

    console.log("\nLogging in as admin and switching to the fixture department...\n");
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    check("Login succeeded", !page.url().includes("/login"));
    const switchResp = await page.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: dept.id } });
    check("Workspace switch to the fixture department succeeded", switchResp.ok());

    // ══════════════════════ 1. Activity completion checkbox: never arms the overlay ══════════════════════
    console.log("\n=== Activity completion checkbox: root click, inner-icon click, click-during-spinner — none arm the overlay ===\n");

    await page.goto(`${BASE_URL}/projects/${project.id}`);
    await page.waitForLoadState("load");
    check("Landed on the Project detail page", page.url().endsWith(`/projects/${project.id}`));
    check("Overlay is hidden at rest", !(await overlayIsVisible(page)));

    // Scoped to THIS specific activity's own row (via its unique Link href)
    // rather than a bare `.first()` — the Activities card orders rows by
    // createdAt DESC, so `otherActivity` (created after activityToToggle)
    // actually renders FIRST; scoping by href guarantees every click below
    // targets the intended activity regardless of row order.
    const toggleRow = page.locator(`a[href="/activities/${activityToToggle.id}"]`).first();
    await toggleRow.waitFor({ state: "visible", timeout: 5000 });
    const checkboxLocator = toggleRow.locator('input[type="checkbox"]');
    await checkboxLocator.waitFor({ state: "visible", timeout: 5000 });

    console.log("\n-- Click 1: the checkbox root --\n");
    await checkboxLocator.click();
    const armedAfterRootClick = await pollOverlayVisible(page, 500);
    check("Clicking the checkbox ROOT never arms the overlay", !armedAfterRootClick);
    check("Page did not navigate away from the Project detail page", page.url().endsWith(`/projects/${project.id}`));
    await page.waitForTimeout(300); // let the (fast) PATCH resolve
    check("The row reflects the new completed state (title now struck through)", (await toggleRow.locator("p.line-through", { hasText: `BV Activity Toggle ${RUN_ID}` }).count()) > 0);
    check("No console/page errors so far", consoleErrors.length === 0);

    console.log("\n-- Click 2: an inner SVG/path element of the Loader2 spinner, while a request is artificially slowed --\n");
    await page.route("**/api/activities/**", async (route) => {
      if (route.request().method() === "PATCH") {
        await new Promise((r) => setTimeout(r, 800));
      }
      await route.continue().catch(() => {}); // benign if a concurrent matching request was already handled
    });
    await checkboxLocator.click(); // toggle back to incomplete — the spinner will render and stay up for ~800ms
    // ActivityCompleteCheckbox renders EXACTLY the Loader2 <svg> in place of
    // the <input> while toggling — no other svg exists in this row
    // (StatusBadge's own "dot" is a <span>, avatars are <img>), so a bare
    // `svg` scoped to this row is an unambiguous, version-independent match
    // (no guessing lucide-react's generated class name).
    const spinnerSvg = toggleRow.locator("svg").first();
    await spinnerSvg.waitFor({ state: "visible", timeout: 2000 });
    // Click a descendant of the spinner SVG itself (its inner <path>/<circle>), not the svg root — proves the ancestor .closest() lookup, not a same-element-only check.
    const innerPath = spinnerSvg.locator("path, circle").first();
    const innerPathExists = (await innerPath.count()) > 0;
    check("The spinner SVG has an inner descendant element to click (path/circle) — a real test of ancestor lookup, not just the SVG root", innerPathExists);
    if (innerPathExists) {
      await innerPath.click({ force: true });
    } else {
      await spinnerSvg.click({ force: true });
    }
    const armedAfterInnerClick = await pollOverlayVisible(page, 500);
    check("Clicking an INNER element of the spinner icon never arms the overlay", !armedAfterInnerClick);
    check("Page still hasn't navigated away", page.url().endsWith(`/projects/${project.id}`));

    console.log("\n-- Click 3: the checkbox area again while the (still-slowed) request is in flight --\n");
    // The spinner is still up (request takes 800ms total); click again in the same area.
    await spinnerSvg.click({ force: true }).catch(() => {}); // may already be gone if timing is tight — best-effort, the poll below is the real assertion
    const armedDuringSpinner = await pollOverlayVisible(page, 400);
    check("Clicking while the loading spinner is rendered never arms the overlay", !armedDuringSpinner);
    await page.waitForTimeout(900); // let the slowed request finish
    await page.unroute("**/api/activities/**");
    check("Overlay is still hidden once the slowed request settles", !(await overlayIsVisible(page)));

    console.log("\n-- Control: a NORMAL row-link click (the Activity title) still arms and resolves the overlay normally --\n");
    await page.route(`**/activities/${otherActivity.id}*`, async (route) => {
      await new Promise((r) => setTimeout(r, 700));
      await route.continue().catch(() => {}); // benign if a concurrent matching request (e.g. a background RSC prefetch) was already handled
    });
    const titleLink = page.locator(`a[href="/activities/${otherActivity.id}"]`).first();
    await titleLink.waitFor({ state: "visible", timeout: 5000 });
    const linkClickTime = Date.now();
    const navSettled = page.waitForURL((url) => url.pathname === `/activities/${otherActivity.id}`, { timeout: 10000 });
    await titleLink.click();
    const armedByRealNav = await pollOverlayVisible(page, 1000);
    check("A NORMAL row-link click (the Activity title, a real navigation) DOES arm the overlay when the navigation is slow", armedByRealNav);
    await navSettled;
    check(`Real navigation resolved and landed on the Activity detail page (took ${Date.now() - linkClickTime}ms, including the injected 700ms delay)`, page.url().endsWith(`/activities/${otherActivity.id}`));
    // The overlay's own hide (stopLoading()) fires from a useEffect reacting
    // to pathname/searchParams AFTER React commits the new route — a brief
    // window can exist between the URL updating (what waitForURL resolves
    // on) and that effect actually running, so this polls rather than
    // asserting synchronously right after navSettled.
    let hiddenAfterNav = false;
    for (let i = 0; i < 20; i++) {
      if (!(await overlayIsVisible(page))) {
        hiddenAfterNav = true;
        break;
      }
      await page.waitForTimeout(50);
    }
    check("Overlay hides again once the real navigation actually settles", hiddenAfterNav);
    await page.unroute(`**/activities/${otherActivity.id}*`);

    // ══════════════════════ 2. MemberPreview: keyboard, focus, Escape, outside click, scroll, touch ══════════════════════
    console.log("\n=== MemberPreview: keyboard focus, open-on-focus, Escape/outside-click close, many-member scroll, touch-no-navigate ===\n");

    await page.goto(`${BASE_URL}/projects?view=list&departmentId=${dept.id}`);
    await page.waitForLoadState("load");
    const memberTrigger = page.getByRole("button", { name: /^Members:/ }).first();
    await memberTrigger.waitFor({ state: "visible", timeout: 5000 });

    console.log("\n-- Keyboard focus opens the preview --\n");
    await page.keyboard.press("Tab"); // best-effort initial focus movement; explicit .focus() below is the real, deterministic step
    await memberTrigger.focus();
    check("Trigger is keyboard-focusable (real DOM focus landed on it)", await memberTrigger.evaluate((el) => el === document.activeElement));
    const tooltipContent = page.getByRole("tooltip");
    await tooltipContent.first().waitFor({ state: "visible", timeout: 2000 }).catch(() => {});
    check("The preview opens on keyboard focus (role=tooltip content visible)", (await tooltipContent.count()) > 0 && (await tooltipContent.first().isVisible()));
    const allEightNamesVisible = await Promise.all(memberNames.map((n) => tooltipContent.first().locator(`text=${n}`).count()));
    check("Every one of the 8 member names is present in the open preview", allEightNamesVisible.every((c) => c > 0));

    console.log("\n-- Many-member content is scrollable (checked while still open from the focus above) --\n");
    const scrollInfo = await tooltipContent.first().locator("ul").first().evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    check(`Many-member list overflows its compact max-height (scrollHeight=${scrollInfo.scrollHeight} > clientHeight=${scrollInfo.clientHeight}), confirming internal scrolling is actually needed/active`, scrollInfo.scrollHeight > scrollInfo.clientHeight);
    // Confirm the row itself never grew to accommodate all 8 names (no expanded row).
    const rowHeight = await page.locator("tr", { has: memberTrigger }).first().evaluate((el) => el.getBoundingClientRect().height);
    check(`The table row stayed compact (height=${rowHeight}px) — the row was never expanded to fit all members`, rowHeight < 100);

    console.log("\n-- Escape closes it --\n");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("Pressing Escape closes the preview", (await tooltipContent.count()) === 0 || !(await tooltipContent.first().isVisible().catch(() => false)));

    console.log("\n-- Outside click closes it (reopened via a real blur+focus cycle first, since Escape alone doesn't move focus away from the trigger) --\n");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await memberTrigger.focus();
    await tooltipContent.first().waitFor({ state: "visible", timeout: 2000 });
    await page.mouse.click(20, 20);
    await page.waitForTimeout(200);
    check("Clicking outside closes the preview", (await tooltipContent.count()) === 0 || !(await tooltipContent.first().isVisible().catch(() => false)));

    console.log("\n-- Touch tap does not navigate the row --\n");
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const touchPage = await touchContext.newPage();
    await login(touchPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    await touchPage.request.post(`${BASE_URL}/api/workspace/active`, { data: { departmentId: dept.id } });
    await touchPage.goto(`${BASE_URL}/projects?view=list&departmentId=${dept.id}`);
    await touchPage.waitForLoadState("load");
    const touchTrigger = touchPage.getByRole("button", { name: /^Members:/ }).first();
    await touchTrigger.waitFor({ state: "visible", timeout: 5000 });
    const urlBeforeTap = touchPage.url();
    await touchTrigger.tap();
    const touchTooltip = touchPage.getByRole("tooltip");
    const touchTooltipAppeared = await touchTooltip
      .first()
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    check("A touch tap on the Members trigger does not navigate the row (URL unchanged)", touchPage.url() === urlBeforeTap);
    check("...and it DOES show the preview content as an equivalent to hover", touchTooltipAppeared);
    await touchContext.close();

    console.log("\n=== Console/network error summary ===\n");
    check("Zero console errors across the run", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the run", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
    console.log("\nCleaning up fixture data...\n");
    const steps: Array<[string, () => Promise<unknown>]> = [
      ["activities", () => prisma.projectActivity.deleteMany({ where: { id: { in: activityIds } } })],
      ["projects", () => prisma.project.deleteMany({ where: { id: { in: projectIds } } })],
      ["users", () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
      ["ticketCategories", () => prisma.ticketCategory.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketPriorities", () => prisma.ticketPriority.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["ticketStatuses", () => prisma.ticketStatus.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityProgressConfig", () => prisma.activityProgressConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["projectStatusConfig", () => prisma.projectStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityStatusConfig", () => prisma.activityStatusConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["activityPriorityConfig", () => prisma.activityPriorityConfig.deleteMany({ where: { departmentId: { in: deptIds } } })],
      ["departments", () => prisma.department.deleteMany({ where: { id: { in: deptIds } } })],
    ];
    for (const [label, step] of steps) {
      try {
        await step();
      } catch (err) {
        console.warn(`Cleanup step "${label}" failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
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
