import { chromium, type Page } from "playwright";
import { prisma } from "@/lib/prisma";

const BASE = "http://localhost:3000";

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
}
function parseRgb(css: string): { r: number; g: number; b: number } | null {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
}
function contrastRatio(fg: string, bg: string): number | null {
  const f = parseRgb(fg);
  const b = parseRgb(bg);
  if (!f || !b) return null;
  const l1 = relativeLuminance(f) + 0.05;
  const l2 = relativeLuminance(b) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}
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
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    console.log("No reachable DATABASE_URL — skipping sections 6/7 (DB-backed regressions) would fail; aborting the whole run.");
    console.log(String(err instanceof Error ? err.message : err));
    process.exit(0);
  }

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

  // --- 6. REGRESSION (Issue A): a hydration mismatch elsewhere on the page
  // must never wipe the already-correct resolved theme off <html> ---
  // Originally reproduced via components/project-requests/project-request-table.tsx's
  // `r.submittedAt.toLocaleDateString()` (no explicit locale formats using
  // the SERVER's default locale during SSR and the BROWSER's own locale on
  // the client). That specific occurrence was fixed in a follow-up task
  // (switched to the app's locale-independent formatDate() helper; see
  // scripts/browser-verify-project-request-date-hydration.ts for its own
  // dedicated regression coverage), so this section's own fixture below no
  // longer actually triggers a mismatch there — left as a standing check
  // (2 iterations is still enough to catch a regression) plus the general
  // defense-in-depth assertion: even WITHOUT any mismatch firing, the
  // `.dark` class must still survive every reload. The broader fix itself —
  // use-theme-preference.ts's mount effect re-asserting the resolved theme
  // via applyResolvedTheme whenever React's hydration-mismatch recovery
  // regenerates the document tree from <html> — remains in place as
  // protection against ANY future hydration mismatch elsewhere on this
  // page, not just this one now-fixed occurrence.
  {
    const dept = await prisma.department.findFirstOrThrow({ select: { id: true } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const fixture = await prisma.projectRequest.create({
      data: {
        title: "Theme-regression fixture request",
        description: "x",
        importance: 2,
        teamConcerned: "QA",
        expectedBenefits: "x",
        requesterId: admin.id,
        departmentId: dept.id,
        // Day > 12 so MM/DD/YYYY and DD/MM/YYYY always render different text.
        submittedAt: new Date("2026-03-20T12:00:00.000Z"),
      },
      select: { id: true },
    });

    try {
      const context = await browser.newContext({ colorScheme: "dark", locale: "en-GB" });
      await context.addInitScript(() => localStorage.setItem("kinsen-theme", "system"));
      const page = await context.newPage();
      const hydrationErrors: string[] = [];
      page.on("pageerror", (err) => {
        if (/[Hh]ydration/.test(err.message)) hydrationErrors.push(err.message);
      });
      await login(page);

      let everMissingDark = false;
      for (let i = 0; i < 10; i++) {
        await page.goto(`${BASE}/project-requests`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(600);
        if (!(await isDark(page))) everMissingDark = true;
      }
      check(
        "no hydration-mismatch pageerror on /project-requests (the list-page occurrence is now fixed — see scripts/browser-verify-project-request-date-hydration.ts)",
        hydrationErrors.length === 0
      );
      check("System + OS dark: .dark class survives every reload regardless (defense in depth, 10 iterations)", !everMissingDark);

      await context.close();
    } finally {
      await prisma.projectRequest.delete({ where: { id: fixture.id } }).catch(() => {});
    }
  }

  // --- 7. REGRESSION (Issue B): notification dropdown unread rows must
  // stay readable in Dark Mode ---
  // Root cause: the unread-row background was
  // `bg-blue-50 dark:bg-blue-900/20/60` — a malformed Tailwind class (two
  // opacity modifiers on one utility). Tailwind never generates a rule for
  // an invalid class like that, so the `dark:` variant silently never
  // applied, leaving the light-only `bg-blue-50` (near-white/light-blue)
  // active in BOTH themes — unreadable against light foreground text in
  // Dark Mode. Fixed by using the existing `bg-primary/5` semantic-token
  // convention already used elsewhere in this app for a subtle highlighted
  // row (e.g. resource-timeline.tsx, people-node.tsx), which resolves
  // against the theme's own --primary HSL value and is therefore correct
  // in both themes automatically.
  {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@kinsen.gr" }, select: { id: true } });
    const unread = await prisma.notification.create({
      data: { userId: admin.id, title: "Theme-regression unread notification", body: "Checking contrast in Dark Mode.", isRead: false },
    });
    const read = await prisma.notification.create({
      data: { userId: admin.id, title: "Theme-regression read notification", body: "Should look visually distinct from the unread one.", isRead: true },
    });

    try {
      const context = await browser.newContext();
      await context.addInitScript(() => localStorage.setItem("kinsen-theme", "dark"));
      const page = await context.newPage();
      await login(page);
      await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);
      await page.click('button:has(svg.lucide-bell), button:has(svg.lucide-bell-off)');
      await page.waitForSelector("text=Theme-regression unread notification", { timeout: 10000 });

      // Passed as a raw STRING, not a closure — tsx/esbuild's dev transform
      // injects a `__name(...)` helper call around named inner functions
      // (find/readStyle below) for readable stack traces; Playwright's
      // function-closure evaluate() only ships the function's own
      // .toString() text to the browser, without that helper's definition,
      // which throws ReferenceError: __name is not defined inside the
      // browser context. A plain string bypasses that transform entirely —
      // same established workaround as browser-verify-project-request-setup-layout.ts's
      // BODY_CHILDREN_SOURCE.
      const STYLES_SOURCE = `
(function () {
  var rows = Array.prototype.map.call(document.querySelectorAll("p.font-medium"), function (p) { return p.closest(".group"); });
  function find(text) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].textContent && rows[i].textContent.includes(text)) return rows[i];
    }
    return null;
  }
  function parseRgba(css) {
    var m = css.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  }
  // The row's own declared background-color can be translucent (e.g. the
  // subtle bg-primary/5 unread highlight) — its PERCEIVED color is that
  // overlay composited on top of whatever opaque ancestor sits behind it
  // (the dropdown's own bg-popover), not the raw rgba() string in
  // isolation. Walks up the DOM compositing every translucent layer onto
  // the first fully-opaque ancestor background found, same "source-over"
  // compositing the browser itself does when painting.
  function effectiveBackground(el) {
    var layers = [];
    var node = el;
    while (node) {
      var c = parseRgba(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    if (layers.length === 0) return { r: 255, g: 255, b: 255, a: 1 };
    // Composite from the outermost (bottom of the stack, pushed last) to
    // the innermost (top layer, pushed first).
    var result = layers[layers.length - 1];
    for (var i = layers.length - 2; i >= 0; i--) {
      var top = layers[i];
      result = {
        r: top.r * top.a + result.r * (1 - top.a),
        g: top.g * top.a + result.g * (1 - top.a),
        b: top.b * top.a + result.b * (1 - top.a),
        a: 1,
      };
    }
    return result;
  }
  function readStyle(el) {
    if (!el) return null;
    var title = el.querySelector("p.font-medium");
    var eff = effectiveBackground(el);
    return {
      rowBg: getComputedStyle(el).backgroundColor,
      effectiveRowBg: "rgb(" + Math.round(eff.r) + ", " + Math.round(eff.g) + ", " + Math.round(eff.b) + ")",
      titleColor: title ? getComputedStyle(title).color : null,
    };
  }
  return {
    unread: readStyle(find("Theme-regression unread notification")),
    read: readStyle(find("Theme-regression read notification")),
  };
})();
`;
      const styles = (await page.evaluate(STYLES_SOURCE)) as {
        unread: { rowBg: string; effectiveRowBg: string; titleColor: string | null } | null;
        read: { rowBg: string; effectiveRowBg: string; titleColor: string | null } | null;
      };

      check("unread notification row found and styled in the dropdown", !!styles.unread);
      check("read notification row found and styled in the dropdown", !!styles.read);

      if (styles.unread) {
        const effBg = parseRgb(styles.unread.effectiveRowBg);
        check(
          `unread row's PERCEIVED (composited) background in Dark Mode is NOT near-white/light-blue (effective ${styles.unread.effectiveRowBg}, declared ${styles.unread.rowBg})`,
          !!effBg && !(effBg.r > 200 && effBg.g > 200 && effBg.b > 200)
        );
        const ratio = styles.unread.titleColor ? contrastRatio(styles.unread.titleColor, styles.unread.effectiveRowBg) : null;
        check(
          `unread row title text has sufficient contrast against its perceived background in Dark Mode (ratio=${ratio?.toFixed(2)}, color=${styles.unread.titleColor}, effective bg=${styles.unread.effectiveRowBg})`,
          !!ratio && ratio >= 4.5
        );
      }
      if (styles.unread && styles.read) {
        check(
          "unread row remains visually distinct from a read row (different declared background)",
          styles.unread.rowBg !== styles.read.rowBg
        );
      }

      await context.close();
    } finally {
      await prisma.notification.deleteMany({ where: { id: { in: [unread.id, read.id] } } });
    }
  }

  await browser.close();
  await prisma.$disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(" -", f));
    process.exit(1);
  }
}

main();
