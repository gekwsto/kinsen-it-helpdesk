/**
 * Regression: credentials must never be submitted through GET / end up in
 * a URL — before React hydration, with JavaScript disabled, on BOTH the
 * normal /login form and the session-renewal credentials form.
 *
 * Reported issue: the credentials <form> had no method/action, so a submit
 * before hydration fell back to a native GET to the current URL, putting
 * the email + password into the query string (URL, history, server/proxy
 * logs).
 *
 *  A. JavaScript disabled: the submit control is disabled; Enter / click
 *     submit nothing.
 *  B. JS enabled but the app bundle blocked (= the pre-hydration window):
 *     same; and even a forced NATIVE submission is a POST to the existing
 *     NextAuth credentials endpoint (credentials only in the body), which
 *     rejects it (no CSRF token) — no session is issued.
 *  C. The same for /auth/session-renew/credentials.
 *  D. After hydration, the normal credentials login still works (POST via
 *     NextAuth signIn), credentials never in any URL.
 *  Every request/navigation URL is recorded and checked for the email and
 *  the password.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-credentials-prehydration.ts
 */
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const RUN_ID = Date.now();
const PASSWORD = `Pw-${RUN_ID}-Secret!`;
const EMAIL = `bv-prehydration-${RUN_ID}@kinsen.gr`;
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const leaks = (s: string) => {
  const d = (() => { try { return decodeURIComponent(s); } catch { return s; } })();
  return d.includes(PASSWORD) || d.includes(EMAIL) || s.includes(encodeURIComponent(PASSWORD)) || s.includes(encodeURIComponent(EMAIL));
};
function recordUrls(context: BrowserContext) {
  const urls: string[] = [];
  const requests: Request[] = [];
  context.on("request", (r) => { urls.push(r.url()); requests.push(r); });
  context.on("page", (p) => p.on("framenavigated", (f) => urls.push(f.url())));
  return { urls, requests };
}
async function blockAppBundle(page: Page) {
  // The pre-hydration window, made deterministic: HTML renders, React never attaches.
  await page.route(/\/_next\/static\/(chunks|webpack)\/.*\.js/, (route) => route.abort());
}
async function sessionCookie(context: BrowserContext) {
  return (await context.cookies(BASE_URL)).some((c) => c.name.startsWith("authjs.session-token"));
}
async function checkUnhydratedForm(page: Page, label: string, rec: { urls: string[]; requests: Request[] }) {
  const form = page.locator('form:has(#credentials-password)');
  await form.waitFor({ timeout: 60000 });
  check(`${label}: the form declares POST to the NextAuth credentials endpoint`, (await form.getAttribute("method"))?.toLowerCase() === "post" && (await form.getAttribute("action")) === "/api/auth/callback/credentials");
  check(`${label}: the submit button is disabled until hydration`, await page.getByRole("button", { name: /Sign in as Admin/ }).isDisabled());
  await page.fill("#credentials-email", EMAIL);
  await page.fill("#credentials-password", PASSWORD);
  const before = page.url();
  await page.press("#credentials-password", "Enter");
  await page.getByRole("button", { name: /Sign in as Admin/ }).click({ force: true, timeout: 2000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  check(`${label}: Enter / click submit nothing (no navigation)`, page.url() === before, page.url());
  check(`${label}: no request or URL ever contains the email/password`, !rec.urls.some(leaks), rec.urls.filter(leaks).join(" | "));
}

async function main() {
  const userIds: string[] = [];
  const browser = await chromium.launch();
  try {
    const bcrypt = await import("bcryptjs");
    const u = await prisma.user.create({ data: { email: EMAIL, name: "BV Prehydration", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: await bcrypt.hash(PASSWORD, 10) } });
    userIds.push(u.id);

    console.log("\n=== A. JavaScript disabled (/login) ===\n");
    {
      const ctx = await browser.newContext({ javaScriptEnabled: false });
      const rec = recordUrls(ctx);
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/login`);
      await checkUnhydratedForm(page, "JS disabled", rec);
      check("JS disabled: no session was issued", !(await sessionCookie(ctx)));
      await ctx.close();
    }

    console.log("\n=== B. Before hydration (/login, app bundle blocked) ===\n");
    {
      const ctx = await browser.newContext();
      const rec = recordUrls(ctx);
      const page = await ctx.newPage();
      await blockAppBundle(page);
      await page.goto(`${BASE_URL}/login`);
      await checkUnhydratedForm(page, "Pre-hydration", rec);
      // Worst case: a NATIVE submission anyway (e.g. browser autofill + submit).
      const [nativeReq] = await Promise.all([
        page.waitForRequest((r) => r.url().includes("/api/auth/callback/credentials"), { timeout: 15000 }),
        page.locator('form:has(#credentials-password)').evaluate((f) => (f as HTMLFormElement).submit()),
      ]);
      await page.waitForLoadState("load").catch(() => undefined);
      check("Pre-hydration native submission is a POST to the NextAuth credentials endpoint", nativeReq.method() === "POST" && new URL(nativeReq.url()).pathname === "/api/auth/callback/credentials" && new URL(nativeReq.url()).search === "");
      check("...with the credentials ONLY in the request body", new URLSearchParams(nativeReq.postData() ?? "").get("password") === PASSWORD && !leaks(nativeReq.url()));
      check("...and NextAuth rejects it (no CSRF token) — no session issued", !(await sessionCookie(ctx)));
      check("...and no URL / history entry ever contains the credentials", !rec.urls.some(leaks) && !leaks(page.url()), [page.url(), ...rec.urls.filter(leaks)].join(" | "));
      await ctx.close();
    }

    console.log("\n=== C. Session-renewal credentials form ===\n");
    {
      const ctx = await browser.newContext();
      const rec = recordUrls(ctx);
      const login = await ctx.newPage();
      await login.goto(`${BASE_URL}/login`);
      await login.locator('form[data-hydrated="true"]').waitFor({ timeout: 60000 });
      await login.fill("#credentials-email", EMAIL);
      await login.fill("#credentials-password", PASSWORD);
      await Promise.all([login.waitForURL((x) => !x.pathname.includes("/login"), { timeout: 120000 }), login.click('button:has-text("Sign in as Admin")')]);
      rec.urls.length = 0;
      const page = await ctx.newPage();
      await blockAppBundle(page);
      await page.goto(`${BASE_URL}/auth/session-renew/credentials`);
      await checkUnhydratedForm(page, "Renewal form, pre-hydration", rec);
      await ctx.close();
    }

    console.log("\n=== D. Hydrated credentials login still works ===\n");
    {
      const ctx = await browser.newContext();
      const rec = recordUrls(ctx);
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/login`);
      await page.locator('form[data-hydrated="true"]').waitFor({ timeout: 60000 });
      check("After hydration the submit button is enabled", await page.getByRole("button", { name: /Sign in as Admin/ }).isEnabled());
      await page.fill("#credentials-email", EMAIL);
      await page.fill("#credentials-password", PASSWORD);
      const [authReq] = await Promise.all([
        page.waitForRequest((r) => r.url().includes("/api/auth/callback/credentials")),
        page.click('button:has-text("Sign in as Admin")'),
      ]);
      await page.waitForURL((x) => !x.pathname.includes("/login"), { timeout: 120000 });
      check("Sign-in goes through NextAuth signIn as a POST (with its CSRF token)", authReq.method() === "POST" && (authReq.postData() ?? "").includes("csrfToken"));
      check("...succeeds (session issued, landed on the app)", (await sessionCookie(ctx)) && new URL(page.url()).pathname === "/dashboard");
      check("...and no URL / history entry contains the credentials", !rec.urls.some(leaks), rec.urls.filter(leaks).join(" | "));
      await ctx.close();
    }
  } finally {
    await browser.close();
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch((e) => console.warn("cleanup", String(e.message).split("\n")[0]));
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
