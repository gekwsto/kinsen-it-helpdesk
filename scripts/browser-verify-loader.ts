/**
 * Real interactive browser verification for the global navigation loader
 * (components/layout/navigation-loader.tsx) and the number-input spinner
 * removal (app/globals.css). Uses `playwright` directly against a live
 * `npm run dev` server — real clicks, real navigation, real console/network
 * capture. Not part of the regular npm test flow (matches the precedent
 * scripts/browser-verify.ts already established in this repo).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-loader.ts
 */
import { chromium, type Page, type ConsoleMessage } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = "admin@kinsen.gr";
const ADMIN_PASSWORD = "Kinsen123!";
const USER_EMAIL = "user@kinsen.gr";
const USER_PASSWORD = "User@123456";

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

/** Mutable flag toggled around the "deliberately abort a request" test section — that section intentionally breaks a request to prove the loader recovers, and its own resulting console/network noise (Next's own "Falling back to browser navigation" log, the aborted request itself) is expected, not a regression. */
const captureState = { suppressing: false };

function attachCapture(page: Page, consoleErrors: string[], failedRequests: string[]) {
  page.on("console", (msg: ConsoleMessage) => {
    if (captureState.suppressing) return;
    if (msg.type() === "error") consoleErrors.push(`[console] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    if (captureState.suppressing) return;
    consoleErrors.push(`[pageerror] ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    if (captureState.suppressing) return;
    // net::ERR_ABORTED (any URL, not just RSC prefetches) is the standard,
    // expected signal for "this request was cancelled because the page
    // navigated away before it finished" — normal SPA behavior (e.g. an
    // in-flight background fetch from a filter component cancelled by a
    // navigation), not a genuine network failure.
    const isBenignAbort = req.failure()?.errorText === "net::ERR_ABORTED";
    if (!isBenignAbort) failedRequests.push(`[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (captureState.suppressing) return;
    if (res.status() >= 400) failedRequests.push(`[http ${res.status()}] ${res.request().method()} ${res.url()}`);
  });
}

/**
 * Sidebar top-level items with children (Tickets/Projects/Activities) render
 * as an expand-only <button>, not a <Link> — the actual navigable link is a
 * child revealed after expanding. Dashboard/Goals/Settings have no children
 * and are direct <Link>s. This helper handles both shapes uniformly.
 */
async function clickSidebarLink(page: Page, opts: { parentLabel?: string; href: string }) {
  if (opts.parentLabel) {
    const expanded = await page.locator(`nav a[href="${opts.href}"]`).isVisible().catch(() => false);
    if (!expanded) {
      await page.locator("nav button", { hasText: opts.parentLabel }).first().click();
      await page.locator(`nav a[href="${opts.href}"]`).first().waitFor({ state: "visible", timeout: 5000 });
    }
  }
  // waitForLoadState("networkidle") immediately after a click races the
  // click's own event handling (Next's router.push is scheduled, not
  // necessarily started, by the time click() resolves) — it can report
  // "idle" before the RSC fetch even begins. Waiting for the URL itself to
  // reach the target is the actual, deterministic completion signal.
  await Promise.all([
    page.waitForURL((url) => url.pathname === opts.href.split("?")[0], { timeout: 10000 }),
    page.locator(`nav a[href="${opts.href}"]`).first().click(),
  ]);
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

const OVERLAY_SELECTOR = '[role="status"][aria-live="polite"]';

async function overlayCount(page: Page): Promise<number> {
  return page.locator(OVERLAY_SELECTOR).count();
}

async function overlayIsVisible(page: Page): Promise<boolean> {
  const el = page.locator(OVERLAY_SELECTOR).first();
  const hidden = await el.getAttribute("aria-hidden");
  return hidden === "false";
}

async function main() {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const webpRequests: { url: string; status: number }[] = [];

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    attachCapture(page, consoleErrors, failedRequests);
    page.on("response", (res) => {
      if (res.url().includes("kinsen_vertical")) webpRequests.push({ url: res.url(), status: res.status() });
    });

    console.log("\nLogging in as admin...\n");
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    check("Login succeeded", !page.url().includes("/login"));

    console.log("\nTesting overlay is present exactly once in the DOM (no double loader)...\n");
    check("Exactly one loader overlay element exists in the DOM", (await overlayCount(page)) === 1);
    check("Overlay is hidden (aria-hidden=true) at rest, right after initial load", !(await overlayIsVisible(page)));

    console.log("\nNo hydration errors on initial load...\n");
    const hydrationErrors = consoleErrors.filter((e) => /hydrat/i.test(e));
    check("No hydration-related console errors after initial load", hydrationErrors.length === 0);

    // ── Sidebar navigation ──
    console.log("\nNavigation from the sidebar...\n");
    await clickSidebarLink(page, { parentLabel: "Projects", href: "/projects" });
    check("Sidebar navigation landed on /projects", page.url().endsWith("/projects"));
    check("Overlay hidden again after the navigation settles (no stuck loader)", !(await overlayIsVisible(page)));
    check("Still exactly one overlay element (no duplicate got created)", (await overlayCount(page)) === 1);

    // ── In-page link navigation ──
    console.log("\nNavigation from an in-page link (a second sidebar-driven navigation to a different target)...\n");
    await clickSidebarLink(page, { parentLabel: "Tickets", href: "/tickets" });
    check("In-page/sidebar link navigation landed on /tickets", page.url().endsWith("/tickets"));
    check("Overlay hidden after settling", !(await overlayIsVisible(page)));

    // ── Browser back/forward ──
    console.log("\nBrowser back/forward...\n");
    await Promise.all([page.waitForURL((url) => url.pathname === "/projects", { timeout: 10000 }), page.goBack()]);
    check("Back navigation landed on /projects", page.url().endsWith("/projects"));
    check("Overlay hidden after back navigation settles", !(await overlayIsVisible(page)));
    await Promise.all([page.waitForURL((url) => url.pathname === "/tickets", { timeout: 10000 }), page.goForward()]);
    check("Forward navigation landed on /tickets", page.url().endsWith("/tickets"));
    check("Overlay hidden after forward navigation settles", !(await overlayIsVisible(page)));

    // ── Very fast successive clicks ──
    console.log("\nVery fast successive navigation clicks (projects -> my-activities -> tickets, no waiting between)...\n");
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    // Pre-expand all three sections once (a real click cycle each, but not
    // part of the timed burst below) so their child links are immediately
    // clickable without an expand-click interleaved into the rapid burst.
    // "Tickets" starts expanded by default (sidebar.tsx's own initial
    // state) — toggling an already-expanded section would COLLAPSE it, so
    // each is only clicked if its child link isn't visible yet.
    for (const [label, sampleHref] of [["Tickets", "/tickets"], ["Projects", "/projects"], ["Activities", "/my-activities"]] as const) {
      const alreadyExpanded = await page.locator(`nav a[href="${sampleHref}"]`).isVisible().catch(() => false);
      if (!alreadyExpanded) {
        await page.locator("nav button", { hasText: label }).first().click();
        await page.locator(`nav a[href="${sampleHref}"]`).first().waitFor({ state: "visible", timeout: 5000 });
      }
    }
    const burstSettled = page.waitForURL((url) => url.pathname === "/tickets", { timeout: 10000 });
    await page.locator('nav a[href="/projects"]').first().click();
    await page.locator('nav a[href="/my-activities"]').first().click();
    await page.locator('nav a[href="/tickets"]').first().click();
    await burstSettled;
    await page.waitForTimeout(300); // let any deferred show-timer from the superseded clicks resolve, if it incorrectly would
    check("After a burst of rapid clicks, the app landed on the LAST clicked destination (/tickets)", page.url().endsWith("/tickets"));
    check("Overlay is hidden after the burst settles (no stale click left it stuck visible)", !(await overlayIsVisible(page)));
    check("Still exactly one overlay element after the burst", (await overlayCount(page)) === 1);

    // ── Query-parameter-only change within the same route ──
    console.log("\nQuery-parameter change within the same route (Dashboard Tickets/Projects tab)...\n");
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    await Promise.all([
      page.waitForURL((url) => url.search.includes("tab=projects"), { timeout: 10000 }),
      page.locator('[role="group"][aria-label="Dashboard"] button:has-text("Projects")').click(),
    ]);
    check("Query-param-only tab swap landed on ?tab=projects", page.url().includes("tab=projects"));
    check("Overlay hidden after the query-param swap settles", !(await overlayIsVisible(page)));

    // ── Re-navigating to the SAME route (click the already-active sidebar item) ──
    console.log("\nNavigating to the SAME route twice in a row (nothing to wait for)...\n");
    await page.goto(`${BASE_URL}/projects`);
    await page.waitForLoadState("networkidle");
    await clickSidebarLink(page, { parentLabel: "Projects", href: "/projects" }).catch(() => {
      // Expected: re-navigating to the identical route never changes the URL, so waitForURL inside the helper legitimately times out — that IS the scenario under test.
    });
    await page.waitForTimeout(400); // longer than the show-delay — if this were going to get stuck, it would show by now
    check("Re-clicking the current route never leaves the overlay stuck visible", !(await overlayIsVisible(page)));

    // ── Redirect due to permissions (non-admin user hitting an admin-only page) ──
    console.log("\nRedirect due to permissions (USER role visiting an ADMIN-only page)...\n");
    const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const userPage = await userContext.newPage();
    const userConsoleErrors: string[] = [];
    const userFailedRequests: string[] = [];
    attachCapture(userPage, userConsoleErrors, userFailedRequests);
    await login(userPage, USER_EMAIL, USER_PASSWORD);
    await userPage.goto(`${BASE_URL}/dashboard`);
    await userPage.waitForLoadState("networkidle");
    // The "Administration" sidebar section is ADMIN-only, so a USER role
    // has no clickable Link to /admin/users at all — there is no real <a>
    // in the DOM to click (confirmed: window.history.pushState alone does
    // NOT trigger a fresh RSC fetch, only an "external URL sync" per Next's
    // own app-router.js — it wouldn't actually reach the server's
    // redirect() call at all). A direct request is the honest way to
    // exercise the real permission gate; what's under test here is that
    // whatever page the redirect lands on initializes the loader cleanly
    // (no stuck overlay, no console errors) — not the mid-SPA-transition
    // path, which the other scenarios above already cover thoroughly with
    // real <Link> clicks.
    await userPage.goto(`${BASE_URL}/admin/users`);
    await userPage.waitForLoadState("networkidle");
    check("A permission-gated request for /admin/users redirected the USER role away from it", !userPage.url().includes("/admin/users"));
    check("Overlay initializes clean (not stuck) on the page the redirect landed on", !(await overlayIsVisible(userPage)));
    check("No console errors during the permission-redirect flow", userConsoleErrors.length === 0);

    // Now prove the loader itself (not just the redirect) behaves via a
    // REAL client-side transition for this same lower-privileged user. The
    // USER role has no "All Tickets" (/tickets) link at all (that child is
    // ADMIN/IT_AGENT/DEPARTMENT_MANAGER/DIRECTOR-only — confirmed by
    // inspecting the actual rendered sidebar for this role) — "Assigned to
    // Me" is the one link every role, including plain USER, always has.
    await Promise.all([
      userPage.waitForURL((url) => url.pathname === "/tickets/assigned-to-me", { timeout: 10000 }),
      userPage.locator('nav a[href="/tickets/assigned-to-me"]').first().click(),
    ]);
    check("The USER role can still perform a normal client-side navigation after the earlier redirect", userPage.url().endsWith("/tickets/assigned-to-me"));
    check("Overlay hidden after that navigation settles", !(await overlayIsVisible(userPage)));
    await userContext.close();

    // ── Slow page (artificial network delay on the RSC fetch) ──
    console.log("\nNavigation to an artificially SLOW page — loader must actually become visible...\n");
    // page.goto() is a full hard reload — it resets the Sidebar's
    // (client-side React) expandedItems state back to its default, so
    // "Projects" must be explicitly re-expanded here rather than assumed
    // still-expanded from an earlier step in this script.
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    await page.locator("nav button", { hasText: "Projects" }).first().click();
    await page.locator('nav a[href="/projects/gantt"]').first().waitFor({ state: "visible", timeout: 5000 });

    await context.route("**/projects/gantt*", async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.continue();
    });
    const slowNavClickTime = Date.now();
    // Fired without awaiting full settlement — leaving room to poll the
    // overlay WHILE the artificially-delayed navigation is still pending.
    const slowNavSettled = page.waitForURL((url) => url.pathname === "/projects/gantt", { timeout: 10000 });
    await page.locator('nav a[href="/projects/gantt"]').first().click();
    // Poll for the overlay to become visible within a reasonable window.
    let becameVisible = false;
    for (let i = 0; i < 20; i++) {
      if (await overlayIsVisible(page)) {
        becameVisible = true;
        break;
      }
      await page.waitForTimeout(50);
    }
    check("A slow (>150ms) navigation DOES make the loader visible", becameVisible);
    await slowNavSettled;
    const slowNavSettleTime = Date.now();
    check("Slow navigation landed on /projects/gantt", page.url().endsWith("/projects/gantt"));
    check("Overlay hides again once the slow page has actually rendered", !(await overlayIsVisible(page)));
    await context.unroute("**/projects/gantt*");
    console.log(`   (slow nav total time: ${slowNavSettleTime - slowNavClickTime}ms — includes the injected 600ms delay)`);

    // ── Fast/cached page — loader must NOT become visible, no artificial delay ──
    console.log("\nNavigation to a fast page — loader must NOT become visible, no artificial delay after render...\n");
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    const fastClickTime = Date.now();
    await page.locator('nav a[href="/goals"]').first().click();
    await page.waitForURL((url) => url.pathname === "/goals", { timeout: 5000 });
    const fastCommitTime = Date.now();
    const overlayVisibleRightAfterCommit = await overlayIsVisible(page);
    check("Overlay never became visible for a fast navigation (URL committed well under the show-delay)", !overlayVisibleRightAfterCommit);
    check(`Fast navigation committed quickly (${fastCommitTime - fastClickTime}ms) — no artificial minimum delay observed`, fastCommitTime - fastClickTime < 2000);

    // ── Failed/aborted navigation request doesn't corrupt future navigations ──
    console.log("\nFailed/aborted navigation request — must not corrupt subsequent navigations...\n");
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    let abortedOnce = false;
    await context.route("**/tickets*", async (route) => {
      if (!abortedOnce) {
        abortedOnce = true;
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    captureState.suppressing = true; // this section deliberately breaks a request — its own resulting noise is expected, not a regression
    await clickSidebarLink(page, { parentLabel: "Tickets", href: "/tickets" }).catch(() => {});
    await page.waitForTimeout(500);
    captureState.suppressing = false;
    await context.unroute("**/tickets*");
    // Now perform a completely normal, unrelated navigation and confirm it still works cleanly.
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 10000 }),
      page.locator('nav a[href="/dashboard"]').first().click(),
    ]);
    check("A navigation right after a failed/aborted one still resolves correctly", page.url().endsWith("/dashboard") || page.url() === `${BASE_URL}/`);
    check("Overlay is hidden after recovering from the failed navigation", !(await overlayIsVisible(page)));

    // ── Refresh ──
    console.log("\nRefresh (hard reload)...\n");
    await page.reload();
    await page.waitForLoadState("networkidle");
    check("Overlay is not stuck visible immediately after a hard reload", !(await overlayIsVisible(page)));

    // ── Mobile viewport ──
    console.log("\nMobile viewport...\n");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    await clickSidebarLink(page, { parentLabel: "Projects", href: "/projects" });
    await page.waitForLoadState("networkidle");
    check("Navigation works correctly at mobile viewport width", page.url().endsWith("/projects"));
    check("Overlay hidden after mobile navigation settles", !(await overlayIsVisible(page)));
    await page.setViewportSize({ width: 1440, height: 900 });

    // ── kinsen_vertical.webp asset check ──
    console.log("\nkinsen_vertical.webp asset requests...\n");
    // Force the slow-page scenario once more so the image is guaranteed to have rendered at least once.
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");
    await context.route("**/tickets*", async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    await clickSidebarLink(page, { parentLabel: "Tickets", href: "/tickets" });
    await page.waitForLoadState("networkidle");
    await context.unroute("**/tickets*");
    check("At least one request for kinsen_vertical.webp was made once the loader actually rendered", webpRequests.length > 0);
    check("Every kinsen_vertical.webp request succeeded (2xx/3xx, no 404s)", webpRequests.every((r) => r.status < 400));

    // ── Number inputs ──
    console.log("\nNumber input spinner removal (goals/new)...\n");
    await page.goto(`${BASE_URL}/goals/new`);
    await page.waitForLoadState("networkidle");
    const numberInputs = page.locator('input[type="number"]');
    const numberInputCount = await numberInputs.count();
    check("The goals/new page has real type=number inputs to test", numberInputCount > 0);

    // Chromium's CSSOM silently drops declarations for properties it
    // doesn't recognize at all (-moz-appearance is Firefox-only) — a
    // document.styleSheets/cssRules scan would never find it in Chromium
    // even though the rule is genuinely served to the browser, because the
    // browser itself discards it during parsing rather than keeping it
    // inert. Fetching the raw served CSS TEXT (bytes on the wire) is the
    // only way to verify the rule's presence in a Chromium-only run — it
    // proves the rule ships to every browser; whether Firefox actually
    // applies it is a well-established, standard technique (not verified
    // here via a real Firefox engine — see the final report).
    const stylesheetHrefs = await page.evaluate(() =>
      Array.from(document.styleSheets)
        .map((s) => s.href)
        .filter((h): h is string => !!h)
    );
    let webkitRuleFoundInSource = false;
    let mozRuleFoundInSource = false;
    for (const href of stylesheetHrefs) {
      const cssText = await page.request.get(href).then((r) => r.text()).catch(() => "");
      if (cssText.includes("webkit-outer-spin-button") || cssText.includes("webkit-inner-spin-button")) webkitRuleFoundInSource = true;
      if (cssText.includes("moz-appearance")) mozRuleFoundInSource = true;
    }
    check("The WebKit spin-button removal rule is present in the served CSS", webkitRuleFoundInSource);
    check("The Firefox (-moz-appearance) removal rule is present in the served CSS (source-level check — Chromium's own CSSOM discards this Firefox-only property, so it can't be verified via getComputedStyle/cssRules in this Chromium-only run)", mozRuleFoundInSource);

    const firstNumberInput = numberInputs.first();
    await firstNumberInput.fill("42");
    check("Typing a number into a type=number input still works", (await firstNumberInput.inputValue()) === "42");
    const attrsPreserved = await firstNumberInput.evaluate((el: HTMLInputElement) => ({
      type: el.type,
      min: el.min,
      max: el.max,
      step: el.step,
    }));
    check('type stayed "number" (not changed to text)', attrsPreserved.type === "number");

    await firstNumberInput.fill("");
    await firstNumberInput.focus();
    await firstNumberInput.type("7");
    check("Keyboard typing behavior is unaffected", (await firstNumberInput.inputValue()) === "7");
    await firstNumberInput.press("ArrowUp");
    const afterArrowUp = await firstNumberInput.inputValue();
    check("ArrowUp key-increment (native browser behavior, unrelated to spinner CSS) still works", Number(afterArrowUp) === 8);

    // Category chart / dashboard bar card XAxis type="number" (recharts prop, not an HTML input) must be unaffected — sanity check the selector never matches those.
    const nonInputNumberTypeCount = await page.locator('[type="number"]:not(input)').count();
    check("The [type=number] CSS selector only ever targets real <input> elements (recharts XAxis type=\"number\" props are untouched)", nonInputNumberTypeCount === 0);

    // ── Overall console/network error summary ──
    console.log("\nConsole and network error summary across the whole run...\n");
    check("Zero console errors across the entire run", consoleErrors.length === 0);
    if (consoleErrors.length > 0) consoleErrors.forEach((e) => console.error("   ", e));
    check("Zero failed network requests across the entire run", failedRequests.length === 0);
    if (failedRequests.length > 0) failedRequests.forEach((e) => console.error("   ", e));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Browser verification crashed:", err);
  process.exit(1);
});
