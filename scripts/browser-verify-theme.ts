import { chromium, type Page } from "playwright";

const BASE = "http://localhost:3000";
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.log("FAIL:", label);
  }
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#credentials-email", { state: "visible", timeout: 10000 });
  await page.waitForTimeout(500); // let React hydrate before submitting
  await page.fill("#credentials-email", "admin@kinsen.gr");
  await page.fill("#credentials-password", "Kinsen123!");
  await page.click('button:has-text("Sign in as Admin")');
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

async function isDark(page: Page) {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

async function colorScheme(page: Page) {
  return page.evaluate(() => document.documentElement.style.colorScheme);
}

async function main() {
  const browser = await chromium.launch();

  // --- 1. Persistence across navigation & reload ---
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await login(page);
    check("initial state: no dark class (default system, light OS)", !(await isDark(page)));

    // Switch to Dark via the Topbar toggle
    await page.click('button[aria-label="Change theme"]');
    await page.click('div[role="menuitemradio"]:has-text("Dark")');
    await page.waitForTimeout(150);
    check("after selecting Dark: html has .dark class", await isDark(page));
    check("after selecting Dark: colorScheme is dark", (await colorScheme(page)) === "dark");

    const storedValue = await page.evaluate(() => localStorage.getItem("kinsen-theme"));
    check("localStorage persisted 'dark'", storedValue === "dark");

    // Navigate to a different page — should remain dark, no flash
    await page.goto(`${BASE}/tickets`, { waitUntil: "domcontentloaded" });
    check("dark persists after navigating to /tickets (checked at domcontentloaded, pre-hydration)", await isDark(page));

    // Reload — should remain dark (tests the FOUC script, not just React state)
    await page.reload({ waitUntil: "domcontentloaded" });
    check("dark persists after reload (FOUC script applied pre-hydration)", await isDark(page));

    await page.waitForTimeout(1500);
    check("no console/page errors after dark-mode reload", consoleErrors.length === 0);
    if (consoleErrors.length) console.log("console errors:", consoleErrors.slice(0, 5));

    await context.close();
  }

  // --- 2. System mode follows OS changes live, no refresh ---
  {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem("kinsen-theme", "system"));
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: "light" });
    await login(page);
    check("system mode + OS light: no dark class", !(await isDark(page)));

    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(150);
    check("system mode + OS switches to dark (no reload): dark class applied live", await isDark(page));

    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(150);
    check("system mode + OS switches back to light (no reload): dark class removed", !(await isDark(page)));

    await context.close();
  }

  // --- 3. Cross-component sync: Topbar toggle <-> Settings card ---
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page);
    await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Flip to Dark via the Settings card
    await page.click('button:has-text("Dark")');
    await page.waitForTimeout(150);
    check("Settings card -> Dark: html has .dark class", await isDark(page));

    // Topbar's own toggle (same page, persistently mounted) should reflect it without reload
    const topbarShowsDark = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label="Change theme"]');
      return btn ? btn.innerHTML.includes("lucide-moon") : false;
    });
    check("Topbar toggle icon updates to Moon after Settings-card change (same-tab sync, no reload)", topbarShowsDark);

    // Flip back to Light via Topbar, confirm Settings card's selected button updates
    await page.click('button[aria-label="Change theme"]');
    await page.click('div[role="menuitemradio"]:has-text("Light")');
    await page.waitForTimeout(150);
    check("Topbar -> Light: html loses .dark class", !(await isDark(page)));

    await context.close();
  }

  // --- 4. Representative pages render without obvious breakage in Dark mode ---
  {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem("kinsen-theme", "dark"));
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`${page.url()}: ${msg.text()}`);
    });
    await login(page);

    const pages = [
      "/dashboard",
      "/tickets",
      "/projects",
      "/activities",
      "/project-requests",
      "/admin/users",
      "/admin/roles",
      "/settings",
    ];

    for (const path of pages) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      const dark = await isDark(page);
      check(`${path}: still dark after navigation`, dark);

      // Heuristic contrast check: sample body text/background colors aren't
      // both near-identical (which would mean invisible text).
      const bgInfo = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        return { bg: body.backgroundColor, color: body.color };
      });
      check(`${path}: body bg/text colors differ (${bgInfo.bg} vs ${bgInfo.color})`, bgInfo.bg !== bgInfo.color);
    }

    // Open a dialog (ticket create cancel-reason or similar) — use Projects "New Project" link then back; instead check a Select + a Dialog generically via Admin Roles delete confirm isn't safe (mutates). Use the mobile sidebar sheet instead as a safe dialog-like overlay check, plus a dropdown (WorkspaceSelector or user menu).
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.setViewportSize({ width: 600, height: 900 });
    await page.waitForTimeout(200);
    await page.click('button[aria-label="Open navigation menu"]');
    await page.waitForTimeout(250);
    const sheetVisible = await page.isVisible('div[role="dialog"]');
    check("mobile sidebar sheet (Radix Dialog overlay) opens and is visible in dark mode", sheetVisible);
    // SheetContent (components/ui/sheet.tsx) puts `bg-sidebar` directly on
    // the dialog root itself (DialogPrimitive.Content, i.e. this exact
    // div[role="dialog"]) — not on some descendant, so read it there.
    const sheetBg = await page.evaluate(() => {
      const el = document.querySelector('div[role="dialog"]');
      return el ? getComputedStyle(el).backgroundColor : null;
    });
    check(`mobile sidebar sheet has a non-transparent background in dark mode (${sheetBg})`, !!sheetBg && sheetBg !== "rgba(0, 0, 0, 0)");
    await page.setViewportSize({ width: 1280, height: 900 });

    // User menu dropdown
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    await page.click('header button:has(svg.lucide-chevron-down)');
    await page.waitForTimeout(200);
    const dropdownVisible = await page.isVisible('div[role="menu"]');
    check("user menu dropdown opens and is visible in dark mode", dropdownVisible);

    if (consoleErrors.length) {
      console.log("Console errors across representative pages:", consoleErrors.slice(0, 10));
    }
    check("no console errors across representative dark-mode pages", consoleErrors.length === 0);

    await context.close();
  }

  // --- 5. Light mode preserved (spot check a couple of pages against baseline look) ---
  {
    const context = await browser.newContext();
    await context.addInitScript(() => localStorage.setItem("kinsen-theme", "light"));
    const page = await context.newPage();
    await login(page);
    check("explicit light mode: no dark class on /dashboard", !(await isDark(page)));
    await page.goto(`${BASE}/projects`, { waitUntil: "domcontentloaded" });
    check("explicit light mode persists on /projects", !(await isDark(page)));
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`light mode body background is white-ish (${bodyBg})`, bodyBg === "rgb(255, 255, 255)");
    await context.close();
  }

  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(" -", f));
    process.exit(1);
  }
}

main();
