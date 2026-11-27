/**
 * Real-browser acceptance for session renewal by re-authentication.
 *
 * Isolated, local sessions with a SHORTENED expiry: after a real
 * credentials sign-in, the session cookie is decrypted and re-encrypted
 * with the app's own next-auth/jwt encode() + AUTH_SECRET (same technique as
 * scripts/test-session-absolute-expiry-http.ts) with absoluteSessionExpiresAt
 * moved to a few seconds/minutes from now. Production session duration and
 * configuration are untouched.
 *
 * Verifies: warning shown; Continue opens ONE renewal popup (repeated clicks
 * never duplicate); successful re-authentication extends the AUTHORITATIVE
 * server expiry; both tabs close the warning; unsaved form data and the page
 * survive; no duplicate listeners; API requests succeed past the ORIGINAL
 * expiry with no warning; popup-blocked and different-account failures show
 * a clear message and leave the session untouched; "Αποσύνδεση τώρα" signs
 * out every tab; a genuinely expired session is rejected.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/browser-verify-session-renewal.ts
 */
import "dotenv/config";
import { chromium, type BrowserContext, type Page } from "playwright";
import { decode, encode } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const COOKIE = "authjs.session-token"; // dev (non-secure) cookie name
const SECRET = process.env.AUTH_SECRET!;
const RUN_ID = Date.now();
const PASSWORD = "BvRenew123!";
const WARNING = "Η συνεδρία σας λήγει σύντομα";
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function readToken(context: BrowserContext): Promise<Record<string, any> | null> {
  const cookies = await context.cookies(BASE_URL);
  if (cookies.some((c) => c.name.startsWith(`${COOKIE}.`))) throw new Error("chunked session cookie — not supported by this test");
  const c = cookies.find((x) => x.name === COOKIE);
  if (!c) return null;
  return (await decode({ token: c.value, secret: SECRET, salt: COOKIE })) as Record<string, any> | null;
}
/** Re-encrypts the CURRENT session with a shortened absolute expiry (isolated local test session). */
async function shortenSession(context: BrowserContext, msFromNow: number): Promise<number> {
  const token = await readToken(context);
  if (!token) throw new Error("no session cookie to shorten");
  const expiresAt = Date.now() + msFromNow;
  token.absoluteSessionExpiresAt = expiresAt;
  token.loginAt = expiresAt - EIGHT_HOURS;
  const value = await encode({ token, secret: SECRET, salt: COOKIE, maxAge: EIGHT_HOURS / 1000 });
  await context.addCookies([{ name: COOKIE, value, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
  return expiresAt;
}
async function login(page: Page, email: string) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill("#credentials-email", email);
  await page.fill("#credentials-password", PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 120000 }), page.click('button:has-text("Sign in as Admin")')]);
}
// Counts live visibilitychange listeners on document (duplicate-listener check).
const INSTRUMENT = `
  (() => {
    window.__visListeners = 0;
    const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (t, l, o) { if (this === document && t === "visibilitychange") window.__visListeners++; return add.call(this, t, l, o); };
    EventTarget.prototype.removeEventListener = function (t, l, o) { if (this === document && t === "visibilitychange") window.__visListeners--; return rem.call(this, t, l, o); };
  })();
`;

async function main() {
  if (!SECRET) throw new Error("AUTH_SECRET not set");
  const userIds: string[] = [];
  const browser = await chromium.launch();
  try {
    const bcrypt = await import("bcryptjs");
    const hash = await bcrypt.hash(PASSWORD, 10);
    const mk = async (tag: string) => { const u = await prisma.user.create({ data: { email: `bv-renew-${tag}-${RUN_ID}@kinsen.gr`, name: `BV Renew ${tag}`, role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true, passwordHash: hash } }); userIds.push(u.id); return u; };
    const user = await mk("u");
    const intruder = await mk("other");

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(INSTRUMENT);
    const page1 = await context.newPage();
    await login(page1, user.email);

    console.log("\n=== 1. Warning shown for a session about to expire ===\n");
    // Type the unsaved draft while the session is still long (no modal yet).
    await page1.goto(`${BASE_URL}/projects/new`, { waitUntil: "load" });
    await page1.locator("#title").waitFor({ timeout: 60000 });
    await page1.waitForLoadState("networkidle").catch(() => undefined);
    const draft = `Unsaved draft ${RUN_ID}`;
    await page1.fill("#title", draft);
    check("(precondition) the draft is in the form before any renewal", (await page1.locator("#title").inputValue()) === draft, await page1.locator("#title").inputValue());
    const page2 = await context.newPage();
    await page2.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
    await page2.waitForLoadState("networkidle").catch(() => undefined);
    // Shorten the session, then let each tab learn it the normal way
    // (SessionProvider re-reads the session when a tab becomes visible) —
    // no reload, so the draft stays in the form.
    const originalExpiry = await shortenSession(context, 80_000);
    for (const pg of [page1, page2]) await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page1.getByText(WARNING).waitFor({ timeout: 30000 });
    await page2.getByText(WARNING).waitFor({ timeout: 30000 });
    check("Both tabs show the warning (session ends in < 5 minutes)", (await page1.getByText(WARNING).count()) === 1 && (await page2.getByText(WARNING).count()) === 1);
    const listenersBefore = await page1.evaluate(() => (window as any).__visListeners);

    console.log("\n=== 2. Continue → one re-authentication popup ===\n");
    let popupsOpened = 0;
    context.on("page", () => { popupsOpened++; });
    const popupPromise = context.waitForEvent("page");
    const continueBtn = page1.getByRole("button", { name: "Συνέχεια εργασίας" });
    await continueBtn.click();
    await continueBtn.click();
    await continueBtn.click();
    const popup = await popupPromise;
    await popup.waitForLoadState("load");
    await popup.waitForLoadState("networkidle").catch(() => undefined);
    await page1.waitForTimeout(500);
    check("Three rapid clicks open exactly ONE renewal popup (no duplicate renewal requests)", popupsOpened === 1, String(popupsOpened));
    check("The waiting tab explains what to do", (await page1.getByTestId("session-renewal-status").count()) === 1);
    await popup.locator("#credentials-email").waitFor({ timeout: 60000 });
    check("Popup is the existing credentials sign-in, pre-filled with the signed-in user's email", (await popup.locator("#credentials-email").inputValue()) === user.email);
    check("...and the warning is still open (closed only after a successful renewal)", (await page1.getByText(WARNING).count()) === 1);

    console.log("\n=== 3. Successful renewal ===\n");
    await popup.fill("#credentials-password", PASSWORD);
    await Promise.all([popup.waitForEvent("close", { timeout: 60000 }), popup.click('button:has-text("Sign in as Admin")')]);
    check("The popup closes itself after the renewed session is announced", popup.isClosed());
    await page1.getByText(WARNING).waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    await page2.getByText(WARNING).waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    check("The warning closes in the tab that renewed", (await page1.getByText(WARNING).count()) === 0);
    check("...and in the OTHER tab too (cross-tab sync)", (await page2.getByText(WARNING).count()) === 0);
    const renewed = await readToken(context);
    check("The AUTHORITATIVE server expiry is a fresh 8h from the re-authentication", !!renewed && renewed.absoluteSessionExpiresAt > originalExpiry + 7 * 3600_000 && Math.abs(renewed.absoluteSessionExpiresAt - (renewed.loginAt + EIGHT_HOURS)) < 1000, JSON.stringify({ exp: renewed?.absoluteSessionExpiresAt, originalExpiry }));
    check("...for the same user", renewed?.sub === user.id || renewed?.id === user.id);
    check("Unsaved form data and the page survived the renewal", (await page1.locator("#title").inputValue()) === draft && new URL(page1.url()).pathname === "/projects/new", JSON.stringify({ value: await page1.locator("#title").inputValue(), url: page1.url() }));
    const listenersAfter = await page1.evaluate(() => (window as any).__visListeners);
    check("No duplicate timers/listeners after the renewal (same live visibilitychange listener count)", listenersAfter === listenersBefore, `${listenersBefore} → ${listenersAfter}`);

    console.log("\n=== 4. Beyond the ORIGINAL expiry ===\n");
    const waitMs = originalExpiry - Date.now() + 20_000; // past the old expiry AND a safety-net cycle
    if (waitMs > 0) await page1.waitForTimeout(waitMs);
    const apiStatus = await page1.evaluate(async () => (await fetch("/api/project-statuses")).status);
    check("An authenticated API request succeeds after the original expiry (200)", apiStatus === 200, String(apiStatus));
    check("The warning does NOT reappear from the old expiry (both tabs)", (await page1.getByText(WARNING).count()) === 0 && (await page2.getByText(WARNING).count()) === 0);
    check("...the user is still on the page with their draft (not signed out)", new URL(page1.url()).pathname === "/projects/new" && (await page1.locator("#title").inputValue()) === draft);

    console.log("\n=== 5. Failed renewals are handled securely ===\n");
    const shortAgain = await shortenSession(context, 4 * 60_000);
    await page2.reload({ waitUntil: "load" });
    await page2.getByText(WARNING).waitFor({ timeout: 30000 });
    await page2.evaluate(() => { (window as any).open = () => null; });
    await page2.getByRole("button", { name: "Συνέχεια εργασίας" }).click();
    check("Popup blocked → a clear message and a same-tab sign-in option (warning stays open)", (await page2.getByTestId("session-renewal-error").innerText()).includes("μπλόκαρε") && (await page2.getByRole("button", { name: /Σύνδεση ξανά σε αυτή την καρτέλα/ }).count()) === 1 && (await page2.getByText(WARNING).count()) === 1);
    await page2.reload({ waitUntil: "load" });
    await page2.getByText(WARNING).waitFor({ timeout: 30000 });
    const popup2Promise = context.waitForEvent("page");
    await page2.getByRole("button", { name: "Συνέχεια εργασίας" }).click();
    const popup2 = await popup2Promise;
    await popup2.waitForLoadState("networkidle").catch(() => undefined);
    await popup2.locator("#credentials-email").waitFor({ timeout: 60000 });
    await popup2.fill("#credentials-email", intruder.email);
    await popup2.fill("#credentials-password", PASSWORD);
    await popup2.click('button:has-text("Sign in as Admin")');
    await popup2.getByTestId("renewal-error").waitFor({ timeout: 30000 });
    check("Signing in with a DIFFERENT account is refused (clear message in the popup)", (await popup2.getByTestId("renewal-error").innerText()).includes("διαφορετικό λογαριασμό"));
    await page2.getByTestId("session-renewal-error").waitFor({ timeout: 15000 });
    check("...the waiting tab shows the failure clearly and keeps the warning open", (await page2.getByTestId("session-renewal-error").innerText()).includes("διαφορετικό λογαριασμό") && (await page2.getByText(WARNING).count()) === 1);
    const afterRefused = await readToken(context);
    check("...and the session is untouched: same user, same (short) expiry — no swap, no extension", (afterRefused?.sub === user.id || afterRefused?.id === user.id) && afterRefused?.absoluteSessionExpiresAt === shortAgain);
    check("...and the intruder's identity was NOT linked to this user", (await prisma.account.count({ where: { userId: user.id } })) === 0);
    await popup2.close();

    console.log("\n=== 6. 'Αποσύνδεση τώρα' still works (all tabs) ===\n");
    await Promise.all([
      page2.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 60000 }),
      page2.getByRole("button", { name: "Αποσύνδεση τώρα" }).click(),
    ]);
    await page1.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => undefined);
    check("Signing out from the warning goes to /login", new URL(page2.url()).pathname === "/login");
    check("...and the other tab is signed out too", new URL(page1.url()).pathname === "/login");
    check("...and the session cookie is gone", (await readToken(context)) === null);
    await context.close();

    console.log("\n=== 7. A genuinely expired session ===\n");
    const ctx2 = await browser.newContext();
    const p = await ctx2.newPage();
    await login(p, user.email);
    await shortenSession(ctx2, -5_000);
    const apiExpired = await p.request.get(`${BASE_URL}/api/project-statuses`);
    check("API request with an expired session is rejected (401), never auto-renewed", apiExpired.status() === 401, String(apiExpired.status()));
    const renewExpired = await p.request.get(`${BASE_URL}/auth/session-renew`, { maxRedirects: 0 });
    check("The renewal route itself refuses an expired session (redirect to sign-in, no renewal started)", [302, 303, 307].includes(renewExpired.status()) && (renewExpired.headers()["location"] ?? "").includes("/login"), `${renewExpired.status()} ${renewExpired.headers()["location"]}`);
    // Existing secure flow: /dashboard -> /login?callbackUrl -> /auth/sso-entry
    // -> sign-out + forced Microsoft re-authentication (covered in detail by
    // scripts/test-sso-entry.ts). Checked hop by hop (the browser can't see
    // server redirects; the final Microsoft hop needs real Entra config and is
    // covered by scripts/test-sso-entry.ts).
    const hop1 = await p.request.get(`${BASE_URL}/dashboard`, { maxRedirects: 0 });
    const hop1Loc = hop1.headers()["location"] ?? "";
    check("Navigating with an expired session is redirected to the sign-in flow, never served the page", [302, 303, 307].includes(hop1.status()) && hop1Loc.includes("/login"), `${hop1.status()} ${hop1Loc}`);
    const hop2 = await p.request.get(new URL(hop1Loc, BASE_URL).toString(), { maxRedirects: 0 });
    const hop2Loc = hop2.headers()["location"] ?? "";
    check("...the expired session cookie is cleared by the server (it can never be reused or renewed)", (await readToken(ctx2)) === null);
    check("...and the sign-in flow continues into authentication (/auth/sso-entry or the login form), never the page", (hop2Loc.includes("/auth/sso-entry") || hop2.status() === 200) && !hop2Loc.includes("/dashboard"), `${hop2.status()} ${hop2Loc}`);
    await ctx2.close();

    console.log("\n=== 8. Renewal security: forged messages, cancellation, logout/expiry during renewal ===\n");
    const hasMarker = async (ctx: BrowserContext) => (await ctx.cookies(BASE_URL)).some((c) => c.name === "kinsen-session-renewal");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const pg = await ctx.newPage();
      await login(pg, user.email);
      const shortExp = await shortenSession(ctx, 4 * 60_000);
      await pg.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
      await pg.getByText(WARNING).waitFor({ timeout: 30000 });
      // A forged cross-tab message claiming a renewal.
      await pg.evaluate(({ uid, exp }) => {
        const ch = new BroadcastChannel("kinsen-session-sync");
        ch.postMessage({ type: "SESSION_RENEWED", userId: uid, absoluteSessionExpiresAt: exp });
        ch.close();
      }, { uid: user.id, exp: Date.now() + EIGHT_HOURS });
      await pg.waitForTimeout(3000);
      const afterForged = await readToken(ctx);
      check("8.1 A forged 'renewed' cross-tab message is NOT proof: the warning stays (server session re-read, unchanged)", (await pg.getByText(WARNING).count()) === 1 && afterForged?.absoluteSessionExpiresAt === shortExp);

      // Popup cancellation.
      let opened = 0;
      ctx.on("page", () => { opened++; });
      const pop1Promise = ctx.waitForEvent("page");
      await pg.getByRole("button", { name: "Συνέχεια εργασίας" }).click();
      const pop1 = await pop1Promise;
      await pop1.waitForLoadState("load");
      await pop1.close();
      await pg.waitForTimeout(1000);
      check("8.2 Cancelling the renewal (closing the popup) changes nothing: warning stays, session unchanged", (await pg.getByText(WARNING).count()) === 1 && (await readToken(ctx))?.absoluteSessionExpiresAt === shortExp);
      const pop2Promise = ctx.waitForEvent("page");
      await pg.getByRole("button", { name: "Συνέχεια εργασίας" }).click();
      const pop2 = await pop2Promise;
      await pop2.waitForLoadState("load");
      check("8.3 ...and Continue can start a fresh attempt afterwards (one new popup)", opened === 2);
      check("8.4 A renewal in progress holds a short-lived renewal marker", await hasMarker(ctx));

      // Logout during renewal.
      await Promise.all([
        pg.waitForURL((x) => x.pathname.startsWith("/login"), { timeout: 60000 }),
        pg.getByRole("button", { name: "Αποσύνδεση τώρα" }).click(),
      ]);
      await pg.waitForTimeout(1000);
      check("8.5 Logout during renewal: the renewal popup is closed", pop2.isClosed());
      check("8.6 ...the session cookie is gone", (await readToken(ctx)) === null);
      check("8.7 ...and the pending renewal marker is cleared server-side (signOut event)", !(await hasMarker(ctx)));
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const pg = await ctx.newPage();
      await login(pg, user.email);
      const exp = await shortenSession(ctx, 25_000);
      await pg.goto(`${BASE_URL}/dashboard`, { waitUntil: "load" });
      await pg.getByText(WARNING).waitFor({ timeout: 30000 });
      const popPromise = ctx.waitForEvent("page");
      await pg.getByRole("button", { name: "Συνέχεια εργασίας" }).click();
      const pop = await popPromise;
      await pop.waitForLoadState("load");
      await pg.waitForURL((x) => x.pathname.startsWith("/login"), { timeout: exp - Date.now() + 30_000 });
      await pg.waitForTimeout(1000);
      check("8.8 Session expiring during a renewal: the absolute expiry still wins — signed out to /login?message=session_expired", new URL(pg.url()).pathname === "/login" && new URL(pg.url()).searchParams.get("message") === "session_expired");
      check("8.9 ...the renewal popup is closed and the session cookie is gone", pop.isClosed() && (await readToken(ctx)) === null);
      const restart = await pg.request.get(`${BASE_URL}/auth/session-renew`, { maxRedirects: 0 });
      check("8.10 ...a renewal can't be (re)started without a valid session", [302, 303, 307].includes(restart.status()) && (restart.headers()["location"] ?? "").includes("/login"));
      // Any leftover marker must be inert once the session is gone: the next
      // person can sign in normally on this browser.
      const next = await ctx.newPage();
      await login(next, intruder.email);
      const nextToken = await readToken(ctx);
      check("8.11 ...and any leftover renewal marker is inert: a different user signs in normally afterwards", new URL(next.url()).pathname !== "/login" && (nextToken?.sub === intruder.id || nextToken?.id === intruder.id), next.url());
      await ctx.close();
    }
  } finally {
    await browser.close();
    await prisma.account.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch((e) => console.warn("user cleanup", String(e.message).split("\n")[0]));
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
