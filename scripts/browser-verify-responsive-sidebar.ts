/**
 * Live browser verification for the responsive Sidebar (off-canvas drawer
 * on mobile/tablet <768px, unchanged persistent Sidebar on desktop
 * >=768px) — components/layout/sidebar.tsx, components/layout/topbar.tsx,
 * components/layout/mobile-sidebar-provider.tsx, components/ui/sheet.tsx.
 *
 * Covers every acceptance item: hidden-by-default + hamburger-opens-drawer
 * on mobile, all 4 close mechanisms (X, backdrop click, Escape, navigation),
 * background scroll lock while open, no horizontal overflow at every
 * required width (390/768/1440/1920/2560), unchanged desktop
 * expanded/collapsed behavior + localStorage persistence, keyboard
 * accessibility (Tab to open, focus trap inside the drawer, focus
 * restoration to the hamburger on close), that navigation/permissions/
 * workspace selection all still work identically, AND the mobile->desktop
 * RESIZE transition (not just a fresh load at each width): opening the
 * drawer at 390px then resizing past 768px must auto-close it and release
 * both the focus trap and the background scroll lock — Radix's Dialog only
 * reacts to its own `open` prop, not to CSS visibility, so a drawer left
 * "open" in state while `md:hidden` just visually hides it would otherwise
 * strand the page non-scrollable/keyboard-trapped despite looking normal
 * (see MobileSidebarProvider's matchMedia effect).
 *
 * Uses a live `npm run dev` server with real demo-account login — not part
 * of the regular npm test flow (matches this repo's established
 * browser-verify-*.ts convention).
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-responsive-sidebar.ts
 */
import { chromium, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_EMAIL = process.env.VERIFY_EMAIL || "admin@kinsen.gr";
const ADMIN_PASSWORD = process.env.VERIFY_PASSWORD || "Kinsen123!";

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

async function login(page: Page) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", ADMIN_EMAIL);
  await page.fill("#credentials-password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15000 }),
    page.click('button:has-text("Sign in as Admin")'),
  ]);
}

async function overflowCheck(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function main() {
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    check("0. Logged in as the demo Admin account", !page.url().includes("/login"));

    // ══════════════════════ No horizontal overflow at every required width ══════════════════════
    console.log("\n=== No horizontal overflow at every required width ===\n");
    for (const width of [390, 768, 1440, 1920, 2560]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
      await page.waitForTimeout(300);
      const { scrollWidth, clientWidth } = await overflowCheck(page);
      check(`Dashboard @ ${width}px — no horizontal overflow (scrollWidth ${scrollWidth} <= clientWidth ${clientWidth})`, scrollWidth <= clientWidth);
    }

    // ══════════════════════ Mobile (<768px): hidden by default, hamburger opens drawer ══════════════════════
    console.log("\n=== Mobile (390px): Sidebar hidden by default, hamburger opens drawer ===\n");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(300);

    const desktopAside = page.locator("aside");
    check("1. Desktop <aside> Sidebar is not visible at 390px", !(await desktopAside.isVisible()));
    const hamburger = page.getByRole("button", { name: "Open navigation menu" });
    check("2. Hamburger button is visible at 390px", await hamburger.isVisible());
    check("3. No drawer dialog present before opening", (await page.locator('[role="dialog"]').count()) === 0);

    await hamburger.click();
    await page.waitForTimeout(350);
    const dialog = page.locator('[role="dialog"]');
    check("4. Drawer opens on hamburger click", await dialog.isVisible());
    check("5. Drawer shows the Dashboard nav link", await dialog.getByRole("link", { name: "Dashboard" }).isVisible());
    check("6. Drawer shows the Tickets nav section (permission-gated items render)", await dialog.getByText("Tickets", { exact: true }).first().isVisible());

    // Background scroll lock while open
    const bodyOverflow = await page.evaluate(() => getComputedStyle(document.body).overflow);
    check(`7. Background scroll is locked while the drawer is open (body overflow: "${bodyOverflow}")`, bodyOverflow === "hidden");

    const { scrollWidth: openSw, clientWidth: openCw } = await overflowCheck(page);
    check("8. No horizontal overflow while the drawer is open", openSw <= openCw);

    // ══════════════════════ Close mechanism 1: X button ══════════════════════
    console.log("\n=== Close mechanisms ===\n");
    await dialog.getByRole("button", { name: "Close menu" }).click();
    await page.waitForTimeout(350);
    check("9. X button closes the drawer", (await page.locator('[role="dialog"]').count()) === 0);
    check("10. Focus returns to the hamburger button after closing via X", await hamburger.evaluate((el) => el === document.activeElement));
    check(`11. Background scroll unlocked after close (body overflow: "${await page.evaluate(() => getComputedStyle(document.body).overflow)}")`, (await page.evaluate(() => getComputedStyle(document.body).overflow)) !== "hidden");

    // Close mechanism 2: backdrop click
    await hamburger.click();
    await page.waitForTimeout(350);
    check("12. Drawer re-opens for the next close-mechanism test", await page.locator('[role="dialog"]').isVisible());
    // Click near the top-right corner of the viewport — outside the ~85vw-capped drawer panel, guaranteed to be backdrop.
    await page.mouse.click(370, 20);
    await page.waitForTimeout(350);
    check("13. Clicking the backdrop closes the drawer", (await page.locator('[role="dialog"]').count()) === 0);
    check("14. Focus returns to the hamburger button after closing via backdrop click", await hamburger.evaluate((el) => el === document.activeElement));

    // Close mechanism 3: Escape key
    await hamburger.click();
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    check("15. Escape key closes the drawer", (await page.locator('[role="dialog"]').count()) === 0);
    check("16. Focus returns to the hamburger button after closing via Escape", await hamburger.evaluate((el) => el === document.activeElement));

    // Close mechanism 4: navigation (clicking a nav link both navigates AND closes)
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    await hamburger.click();
    await page.waitForTimeout(350);
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/tickets", { timeout: 10000 }),
      page.locator('[role="dialog"]').getByRole("link", { name: "All Tickets" }).click(),
    ]);
    check("17. Clicking a nav link navigates to the real target", page.url().endsWith("/tickets"));
    // The pathname-change effect closes the drawer asynchronously, then
    // Radix's own ~200ms close animation runs before it unmounts — give
    // that its own generous margin rather than reusing the fixed 350ms
    // used for the instant (non-animated-navigation) close mechanisms above.
    await page.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    check("18. ...and closes the drawer as part of navigating", (await page.locator('[role="dialog"]').count()) === 0);

    // ══════════════════════ Resize transition: mobile -> desktop auto-closes the drawer ══════════════════════
    console.log("\n=== Resize transition: open at 390px, resize to 1440px — drawer must auto-close, scroll/keyboard release ===\n");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    await hamburger.click();
    await page.waitForTimeout(350);
    check("18b. Drawer is open at 390px before the resize", await page.locator('[role="dialog"]').isVisible());
    check("18c. Background scroll is locked before the resize", (await page.evaluate(() => getComputedStyle(document.body).overflow)) === "hidden");

    // The resize itself — no click, no Escape, nothing but crossing the
    // breakpoint. This is the exact scenario a plain `md:hidden` CSS rule
    // can't handle on its own (it only hides the panel, Radix's `open`
    // state is untouched by a CSS visibility change).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(350);
    check("18d. Drawer auto-closes after resizing past the 768px breakpoint (no click/Escape/navigation involved)", (await page.locator('[role="dialog"]').count()) === 0);
    check(
      `18e. Background scroll is released after the resize (body overflow: "${await page.evaluate(() => getComputedStyle(document.body).overflow)}")`,
      (await page.evaluate(() => getComputedStyle(document.body).overflow)) !== "hidden"
    );

    // Scrolling actually works again (not just the CSS property reset) —
    // scroll the <main> content area and confirm it moved.
    const scrollBefore = await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
    await page.evaluate(() => document.querySelector("main")?.scrollBy(0, 300));
    await page.waitForTimeout(150);
    const scrollAfter = await page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
    check(`18f. Page content actually scrolls again after the resize (scrollTop ${scrollBefore} -> ${scrollAfter})`, scrollAfter > scrollBefore);

    // Keyboard interaction works normally (not trapped in a now-invisible dialog).
    await page.keyboard.press("Tab");
    const focusTrappedInDialog = await page.evaluate(() => {
      const dialogEl = document.querySelector('[role="dialog"]');
      return !!dialogEl && dialogEl.contains(document.activeElement);
    });
    check("18g. Keyboard Tab is not trapped in any (now-closed) dialog after the resize", !focusTrappedInDialog);
    const desktopAsideVisibleAfterResize = await page.locator("aside").isVisible();
    check("18h. Desktop Sidebar renders normally after the transition", desktopAsideVisibleAfterResize);

    // Resize back down — drawer must stay closed until explicitly reopened, never auto-reopen itself.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    check("18i. Resizing back to 390px leaves the drawer closed (it does not auto-reopen)", (await page.locator('[role="dialog"]').count()) === 0);
    await hamburger.click();
    await page.waitForTimeout(350);
    check("18j. The drawer still opens normally via the hamburger after the round-trip resize", await page.locator('[role="dialog"]').isVisible());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);

    // ══════════════════════ Keyboard accessibility ══════════════════════
    console.log("\n=== Keyboard accessibility ===\n");
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    await hamburger.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(350);
    check("19. Enter key on the focused hamburger opens the drawer", await page.locator('[role="dialog"]').isVisible());

    // Focus trap: Tab repeatedly and confirm focus never escapes the dialog.
    let allTabsStayedInDialog = true;
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const inDialog = await page.evaluate(() => {
        const dialogEl = document.querySelector('[role="dialog"]');
        return !!dialogEl && dialogEl.contains(document.activeElement);
      });
      if (!inDialog) {
        allTabsStayedInDialog = false;
        break;
      }
    }
    check("20. Tabbing repeatedly never moves focus outside the open drawer (focus trap)", allTabsStayedInDialog);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    check("21. Escape closes the drawer opened via keyboard", (await page.locator('[role="dialog"]').count()) === 0);
    check("22. Focus restored to the hamburger after keyboard-driven open/close", await hamburger.evaluate((el) => el === document.activeElement));

    // ══════════════════════ Desktop (>=768px): unchanged Sidebar behavior ══════════════════════
    console.log("\n=== Desktop (1440px): existing Sidebar behavior unchanged ===\n");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    check("23. Desktop <aside> Sidebar is visible at 1440px", await desktopAside.isVisible());
    check("24. Hamburger button is NOT visible at 1440px", !(await hamburger.isVisible()));
    check("25. No drawer/dialog is mounted at desktop width", (await page.locator('[role="dialog"]').count()) === 0);

    const collapseButton = page.getByRole("button", { name: "Collapse sidebar" });
    check("26. Desktop collapse toggle button is present", await collapseButton.isVisible());
    const asideWidthBefore = await desktopAside.evaluate((el) => el.getBoundingClientRect().width);
    await collapseButton.click();
    await page.waitForTimeout(300);
    const asideWidthAfterCollapse = await desktopAside.evaluate((el) => el.getBoundingClientRect().width);
    check(`27. Collapsing the desktop Sidebar actually shrinks it (${asideWidthBefore}px -> ${asideWidthAfterCollapse}px)`, asideWidthAfterCollapse < asideWidthBefore);

    const storedCollapsed = await page.evaluate(() => localStorage.getItem("sidebar-collapsed"));
    check(`28. Collapsed state is persisted to localStorage (got "${storedCollapsed}")`, storedCollapsed === "true");

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(300);
    const asideWidthAfterReload = await desktopAside.evaluate((el) => el.getBoundingClientRect().width);
    check(`29. Collapsed state persists across a reload (width stays ${asideWidthAfterReload}px, not back to ${asideWidthBefore}px)`, asideWidthAfterReload < asideWidthBefore);

    // Restore expanded state so this script is re-runnable / leaves no stray state for a human tester.
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.waitForTimeout(300);
    const asideWidthRestored = await desktopAside.evaluate((el) => el.getBoundingClientRect().width);
    check("30. Expanding again restores the original width", Math.abs(asideWidthRestored - asideWidthBefore) < 2);

    // Active-link highlighting still works (unchanged logic, just verifying no regression from the render-function refactor).
    await page.goto(`${BASE_URL}/tickets`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const ticketsLinkClasses = await page.locator("aside").getByRole("link", { name: "All Tickets" }).first().getAttribute("class");
    check("31. Active-link highlighting still applies the active background class", !!ticketsLinkClasses && /bg-sidebar-primary/.test(ticketsLinkClasses));

    // ══════════════════════ Permissions preserved — same nav items rendered on desktop vs. mobile drawer ══════════════════════
    console.log("\n=== Navigation/permissions parity between desktop Sidebar and mobile drawer ===\n");
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const desktopTopLevelLabels = await page.locator("aside nav a, aside nav button").evaluateAll((els) =>
      els.map((el) => el.textContent?.trim()).filter(Boolean)
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await hamburger.click();
    await page.waitForTimeout(350);
    const mobileTopLevelLabels = await page.locator('[role="dialog"] nav a, [role="dialog"] nav button').evaluateAll((els) =>
      els.map((el) => el.textContent?.trim()).filter(Boolean)
    );
    check(
      "32. The mobile drawer renders the exact same permission-gated nav items as the desktop Sidebar",
      JSON.stringify(desktopTopLevelLabels) === JSON.stringify(mobileTopLevelLabels),
      `desktop=${JSON.stringify(desktopTopLevelLabels)} mobile=${JSON.stringify(mobileTopLevelLabels)}`
    );

    // ══════════════════════ Workspace selection still functional ══════════════════════
    console.log("\n=== Workspace selection remains functional ===\n");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    // `header button`'s first DOM match is ALWAYS the hamburger (it's
    // first in markup order) regardless of viewport — `md:hidden` only
    // hides it visually, it's still present in the DOM to query. Exclude
    // it by its stable aria-label instead of relying on DOM order.
    const workspaceSelectorButton = page.locator('header button:not([aria-label="Open navigation menu"])').first();
    check("33. Workspace selector is present and visible on desktop", await workspaceSelectorButton.isVisible());
    await workspaceSelectorButton.click();
    await page.waitForTimeout(300);
    check("33b. Clicking the workspace selector opens its dropdown", (await page.locator('[role="menu"]').count()) > 0 || (await page.getByText("Switch workspace").count()) > 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    console.log("\n=== Console/page errors across the whole run ===\n");
    check("34. No browser console errors occurred", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
    check("35. No uncaught page errors occurred", pageErrors.length === 0, pageErrors.slice(0, 5).join(" | "));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
