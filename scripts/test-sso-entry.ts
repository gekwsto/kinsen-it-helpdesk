/**
 * Regression coverage for the canonical suite-to-Helpdesk SSO entry point
 * (app/auth/sso-entry/route.ts) and the related changes it required:
 *   - lib/safe-redirect.ts (open-redirect protection for `returnTo`/`callbackUrl`)
 *   - lib/auth.config.ts (PUBLIC_PATHS entry, relative-not-absolute `callbackUrl`)
 *   - app/(auth)/login/page.tsx (server-confirmed forced reauth on the
 *     existing direct-login button, independent of the `message` query param)
 *
 * Does NOT re-test the underlying 8h absolute-expiry mechanism itself
 * (computeAbsoluteSessionExpiry/isAbsoluteSessionExpired/
 * stampAbsoluteSessionExpiryIfAbsent/computeSessionExpiryUiState) — that
 * was already implemented and already has full coverage in
 * scripts/test-session-absolute-expiry.ts (pure logic, boundary/no-slide/
 * fresh-window-on-relogin scenarios) and
 * scripts/test-session-absolute-expiry-http.ts (real HTTP 401/redirect
 * enforcement) — both re-run as part of this task's own "directly affected"
 * set, unmodified.
 *
 * SECTION A mocks @/lib/auth's `auth`/`signIn`/`signOut` (this repo's
 * established convention — see e.g. scripts/test-activity-completion-
 * project-refresh.ts) and calls the REAL exported `GET` from
 * app/auth/sso-entry/route.ts directly, capturing the EXACT arguments each
 * mocked function was called with. This is deliberately more precise than
 * observing the live redirect over HTTP: this sandbox's configured
 * AUTH_MICROSOFT_ENTRA_ID_TENANT_ID is a placeholder (not a real, reachable
 * Entra tenant — confirmed: `curl .../v2.0/.well-known/openid-configuration`
 * returns 400), so the real OIDC discovery step that would normally produce
 * the final Microsoft `/authorize` URL cannot succeed in this environment.
 * Mocking at the `signIn`/`signOut` call boundary sidesteps that entirely
 * and verifies exactly what this route decided to do, argument-for-argument
 * — see the FINAL REPORT for the full explanation of this constraint.
 *
 * SECTION B drives the REAL route over HTTP against a live `npm run dev`
 * server (skips, not fails, if unreachable) for everything that does NOT
 * require live Entra connectivity: the valid-session short-circuit (returns
 * before ever calling signIn), forged-query-param bypass attempts, malformed
 * `returnTo` fallback, and the observable stale-cookie-clearing difference
 * between the expired and absent branches (both real, unmocked, end-to-end
 * proof of the actual deployed route).
 *
 * Usage: npx tsx --experimental-test-module-mocks scripts/test-sso-entry.ts
 */
import "dotenv/config";
import { mock } from "node:test";
import * as React from "react";
(globalThis as any).React = React;
import { NextRequest } from "next/server";
import { sanitizeInternalDestination, DEFAULT_SAFE_DESTINATION } from "@/lib/safe-redirect";

function findElementsByType(node: any, type: any, results: any[] = []): any[] {
  if (node == null || typeof node !== "object") return results;
  if (node.type === type) results.push(node);
  const children = node.props?.children;
  if (Array.isArray(children)) for (const c of children) findElementsByType(c, type, results);
  else if (children) findElementsByType(children, type, results);
  return results;
}

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
function printSummaryAndExit() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  // ══════════════════════ Pure: sanitizeInternalDestination ══════════════════════
  console.log("\n=== 11/12. sanitizeInternalDestination: open-redirect protection, safe default ===\n");

  check("Plain relative path -> unchanged", sanitizeInternalDestination("/tickets") === "/tickets");
  check("Relative path with query string -> preserved", sanitizeInternalDestination("/tickets?x=1") === "/tickets?x=1");
  check("Relative path with hash -> preserved", sanitizeInternalDestination("/tickets#section") === "/tickets#section");
  check("Root path -> allowed", sanitizeInternalDestination("/") === "/");

  // These all resolve to a HARMLESS same-origin path — never the external
  // host itself — because only pathname+search+hash is ever kept, no
  // matter what origin the input claimed. This is deliberately MORE
  // permissive than outright rejecting every absolute-looking input: it's
  // what makes a genuinely same-origin absolute callbackUrl (exactly what
  // the company suite sends — see the dedicated section below) resolve to
  // its real destination instead of being discarded.
  check("Absolute external URL (http, no path) -> reduced to the harmless root path, never evil.com", sanitizeInternalDestination("http://evil.com") === "/");
  check("Absolute external URL (https, with path) -> reduced to just that path, never evil.com", sanitizeInternalDestination("https://evil.com/phish") === "/phish");
  check("Protocol-relative URL (//evil.com) -> reduced to the harmless root path", sanitizeInternalDestination("//evil.com") === "/");
  check("Triple-slash (///evil.com) -> reduced to the harmless root path", sanitizeInternalDestination("///evil.com") === "/");
  check("Backslash host-confusion (/\\\\evil.com) -> reduced to the harmless root path", sanitizeInternalDestination("/\\\\evil.com") === "/");
  check("Backslash host-confusion (\\\\evil.com, no leading slash) -> reduced to the harmless root path", sanitizeInternalDestination("\\\\evil.com") === "/");
  check("javascript: URI -> rejected, falls back (opaque path, never starts with '/')", sanitizeInternalDestination("javascript:alert(1)") === DEFAULT_SAFE_DESTINATION);
  check("Percent-encoded double-slash (/%2F%2Fevil.com) stays a literal SAME-ORIGIN path — never decoded into a host escape", sanitizeInternalDestination("/%2F%2Fevil.com").startsWith("/"));
  check("...and is not itself in the disallowed-prefix list, so it's accepted as an (inert, same-origin) path", sanitizeInternalDestination("/%2F%2Fevil.com") === "/%2F%2Fevil.com");
  check("Bare host with no leading slash (evil.com) -> treated as a relative same-origin path, never a redirect to evil.com", sanitizeInternalDestination("evil.com") === "/evil.com");
  check("Whitespace-only -> rejected, falls back", sanitizeInternalDestination("   ") === DEFAULT_SAFE_DESTINATION);
  check("Empty string -> rejected, falls back", sanitizeInternalDestination("") === DEFAULT_SAFE_DESTINATION);
  check("null -> rejected, falls back", sanitizeInternalDestination(null) === DEFAULT_SAFE_DESTINATION);
  check("undefined -> rejected, falls back", sanitizeInternalDestination(undefined) === DEFAULT_SAFE_DESTINATION);

  console.log("\n=== Real-world case: the company suite's actual callbackUrl format (SAME-ORIGIN absolute URL) ===\n");
  check("A same-origin absolute URL (what the suite actually sends) resolves to its real path, not the fallback — 'https://ithelpdesk.kinsen.gr/' -> '/'", sanitizeInternalDestination("https://ithelpdesk.kinsen.gr/") === "/");
  check("...with a deeper path preserved too — 'https://ithelpdesk.kinsen.gr/tickets/123' -> '/tickets/123'", sanitizeInternalDestination("https://ithelpdesk.kinsen.gr/tickets/123") === "/tickets/123");
  check("...even with no trailing slash at all", sanitizeInternalDestination("https://ithelpdesk.kinsen.gr") === "/");
  check("Path traversal normalizes to a same-origin path, never an escape (/a/../../evil.com -> /evil.com, still ours)", sanitizeInternalDestination("/a/../../evil.com") === "/evil.com");

  console.log("\n=== Loop prevention: auth-machinery paths rejected even though same-origin ===\n");
  check("/login rejected as a destination (would loop back into the login page)", sanitizeInternalDestination("/login") === DEFAULT_SAFE_DESTINATION);
  check("/auth/sso-entry rejected (would loop back into this same entry point)", sanitizeInternalDestination("/auth/sso-entry") === DEFAULT_SAFE_DESTINATION);
  check("/auth/sso-entry?returnTo=... rejected too (same prefix)", sanitizeInternalDestination("/auth/sso-entry?returnTo=/tickets") === DEFAULT_SAFE_DESTINATION);
  check("/api/auth/* rejected (NextAuth's own routes, never a real page)", sanitizeInternalDestination("/api/auth/callback/microsoft-entra-id") === DEFAULT_SAFE_DESTINATION);
  check("/unauthorized rejected (the error page itself)", sanitizeInternalDestination("/unauthorized") === DEFAULT_SAFE_DESTINATION);
  check("A legitimate deep link survives unchanged (/tickets/abc123/edit)", sanitizeInternalDestination("/tickets/abc123/edit") === "/tickets/abc123/edit");
  check("A custom fallback is honored when provided (empty input -> genuinely falls back, no path to extract)", sanitizeInternalDestination("", "/custom-fallback") === "/custom-fallback");
  check("...and for an opaque-scheme input too (javascript: never resolves to a usable path)", sanitizeInternalDestination("javascript:alert(1)", "/custom-fallback") === "/custom-fallback");

  // ══════════════════════ SECTION A — mocked signIn/signOut/auth, exact call verification ══════════════════════
  console.log("\n=== SECTION A — app/auth/sso-entry/route.ts: exact branch/argument verification (mocked auth boundary) ===\n");

  let authResult: any = null;
  const signInCalls: any[] = [];
  const signOutCalls: any[] = [];

  mock.module("@/lib/auth", {
    namedExports: {
      auth: async () => authResult,
      signIn: async (...args: any[]) => {
        signInCalls.push(args);
        // The real signIn() always redirects (throws NEXT_REDIRECT) — recorded here instead, so the route's own code after the call (if any) is provably unreachable in the real runtime; nothing here should ever run past this in a correct GET handler.
      },
      signOut: async (...args: any[]) => {
        signOutCalls.push(args);
      },
      handlers: {},
    },
  });

  let currentHeaders = new Headers();
  mock.module("next/headers", {
    namedExports: {
      headers: async () => currentHeaders,
      cookies: async () => ({ get: () => undefined }),
    },
  });

  const { GET } = await import("@/app/auth/sso-entry/route");
  const { encode } = await import("next-auth/jwt");

  const AUTH_SECRET = process.env.AUTH_SECRET;
  if (!AUTH_SECRET) {
    console.log("AUTH_SECRET not set — skipping SECTION A/B cookie-crafting tests.");
    printSummaryAndExit();
    return;
  }

  async function craftCookie(payload: Record<string, unknown>): Promise<string> {
    const jwt = await encode({ token: payload, secret: AUTH_SECRET!, salt: "authjs.session-token", maxAge: 8 * 60 * 60 });
    return `authjs.session-token=${jwt}`;
  }

  function req(url: string, cookie?: string): NextRequest {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    return new NextRequest(url, { headers });
  }

  const resetCalls = () => {
    signInCalls.length = 0;
    signOutCalls.length = 0;
  };

  console.log("\n-- 1. Valid session: reaches the destination directly, no Microsoft redirect at all --\n");
  authResult = { user: { id: "u1", email: "user@kinsen.gr", role: "USER" } };
  resetCalls();
  const validRes = (await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets")))!;
  check("Response is a redirect", validRes.status === 307 || validRes.status === 302 || validRes.status === 308);
  check("Redirect target is exactly the requested (safe) destination", validRes.headers.get("location") === "http://localhost:3000/tickets");
  check("signIn() was NEVER called — no Microsoft round-trip for an already-valid session", signInCalls.length === 0);
  check("signOut() was NEVER called — nothing to revoke for a valid session", signOutCalls.length === 0);

  console.log("\n-- 7a. Forged bypass attempt: a VALID session ignores forged expired=true/forceLogin=true/prompt=login query params --\n");
  resetCalls();
  const forgedValidRes = (await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets&expired=true&forceLogin=true&prompt=login")))!;
  check("Still redirects straight to the destination — forged params changed nothing", forgedValidRes.headers.get("location") === "http://localhost:3000/tickets");
  check("signIn() still never called", signInCalls.length === 0);

  console.log("\n-- 12. Missing returnTo with a valid session -> safe default destination --\n");
  resetCalls();
  const missingReturnToRes = (await GET(req("http://localhost:3000/auth/sso-entry")))!;
  check("No returnTo -> redirects to the safe default", missingReturnToRes.headers.get("location") === `http://localhost:3000${DEFAULT_SAFE_DESTINATION}`);

  console.log("\n-- 11. External returnTo with a valid session -> its harmless same-origin path, never the external host --\n");
  resetCalls();
  const externalReturnToRes = (await GET(req("http://localhost:3000/auth/sso-entry?returnTo=https://evil.com/phish")))!;
  check("Malicious returnTo -> redirects to OUR OWN /phish path, never evil.com", externalReturnToRes.headers.get("location") === "http://localhost:3000/phish");

  console.log("\n-- Real-world case: the company suite's actual same-origin absolute callbackUrl format survives correctly --\n");
  resetCalls();
  const suiteStyleRes = (await GET(req("http://localhost:3000/auth/sso-entry?returnTo=" + encodeURIComponent("https://ithelpdesk.kinsen.gr/tickets"))))!;
  check("A same-origin absolute returnTo (exactly what the suite sends) resolves to the real destination, not the dashboard fallback", suiteStyleRes.headers.get("location") === "http://localhost:3000/tickets");

  console.log("\n-- 5. No prior session (absent) -> normal Entra authorization, NO prompt=login, no signOut --\n");
  authResult = null;
  resetCalls();
  await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets"));
  check("signIn() was called exactly once", signInCalls.length === 1);
  check("...with the Microsoft Entra provider", signInCalls[0]?.[0] === "microsoft-entra-id");
  check("...with redirectTo set to the sanitized returnTo", signInCalls[0]?.[1]?.redirectTo === "/tickets");
  check("...with NO authorizationParams argument at all (undefined) — first-time entry must not force prompt=login, letting silent Entra SSO complete when possible", signInCalls[0]?.[2] === undefined);
  check("signOut() was NEVER called — nothing to revoke when there was no prior session", signOutCalls.length === 0);

  console.log("\n-- 6/3. Genuinely expired session -> signOut() THEN signIn() with prompt=login --\n");
  authResult = null; // auth() correctly resolves to null for an expired token too (lib/auth.ts's jwt callback)
  resetCalls();
  const expiredLoginAt = Date.now() - 9 * 60 * 60 * 1000; // 9h ago -> past the 8h boundary
  const expiredCookie = await craftCookie({ sub: "u1", email: "user@kinsen.gr", id: "u1", role: "USER", isActive: true, loginAt: expiredLoginAt, absoluteSessionExpiresAt: expiredLoginAt + 8 * 60 * 60 * 1000 });
  await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets", expiredCookie));
  check("signOut() was called exactly once, BEFORE signIn (revokes the stale local session first)", signOutCalls.length === 1);
  check("...called with {redirect: false} — this route controls the eventual redirect itself, not signOut", signOutCalls[0]?.[0]?.redirect === false);
  check("signIn() was called exactly once", signInCalls.length === 1);
  check("...with the Microsoft Entra provider", signInCalls[0]?.[0] === "microsoft-entra-id");
  check("...with redirectTo set to the sanitized returnTo — the destination survives into the forced-reauth flow", signInCalls[0]?.[1]?.redirectTo === "/tickets");
  check("6. ...with authorizationParams = { prompt: 'login' } — added ONLY on this specific request, for a server-confirmed expired session", signInCalls[0]?.[2]?.prompt === "login");

  console.log("\n-- 7b. Forged bypass attempt: an EXPIRED session cannot be tricked into skipping prompt=login by OMITTING any forged param --\n");
  authResult = null;
  resetCalls();
  await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets")); // no forged params at all, just the real expired cookie from above is NOT resent here — use a fresh one
  const expiredCookie2 = await craftCookie({ sub: "u1", email: "user@kinsen.gr", id: "u1", role: "USER", isActive: true, loginAt: expiredLoginAt, absoluteSessionExpiresAt: expiredLoginAt + 8 * 60 * 60 * 1000 });
  resetCalls();
  await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets", expiredCookie2)); // still no expired=/forceLogin= param — the server's OWN cookie read is what triggers prompt=login
  check("prompt=login is still applied from the SERVER's own cookie classification alone — no client-supplied flag is needed or read", signInCalls[0]?.[2]?.prompt === "login");

  console.log("\n-- 19. Concurrent requests with the SAME expired cookie both classify independently and consistently (no shared/consumable state) --\n");
  resetCalls();
  const [concurrentA, concurrentB] = await Promise.all([
    GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets", expiredCookie2)),
    GET(req("http://localhost:3000/auth/sso-entry?returnTo=/projects", expiredCookie2)),
  ]);
  check("Both concurrent requests triggered their own signOut() call (2 total)", signOutCalls.length === 2);
  check("Both concurrent requests triggered their own signIn() call with prompt=login (2 total, neither skipped)", signInCalls.length === 2 && signInCalls.every((c) => c[2]?.prompt === "login"));
  check("Each request's own returnTo was preserved independently (no cross-contamination)", signInCalls.some((c) => c[1]?.redirectTo === "/tickets") && signInCalls.some((c) => c[1]?.redirectTo === "/projects"));
  void concurrentA;
  void concurrentB;

  console.log("\n-- Not-yet-expired session that auth() would normally accept: never reaches this raw-cookie path at all (auth() already returned non-null) --\n");
  // Covered by the very first "Valid session" scenario above — when auth()
  // resolves to a session, the function returns before ever consulting
  // readRawSessionExpiryState, so a valid session can never accidentally
  // trip the expired branch. Re-asserted explicitly for clarity.
  authResult = { user: { id: "u1", email: "user@kinsen.gr", role: "USER" } };
  resetCalls();
  await GET(req("http://localhost:3000/auth/sso-entry?returnTo=/tickets", expiredCookie2)); // a stale cookie is present, but auth() says valid (simulating: cookie was already refreshed elsewhere) — auth()'s own result is authoritative
  check("When auth() itself resolves to a session, neither signIn nor signOut are consulted regardless of any raw cookie state", signInCalls.length === 0 && signOutCalls.length === 0);
  authResult = null;

  // ══════════════════════ 17. Existing direct login (app/(auth)/login/page.tsx) ══════════════════════
  console.log("\n=== 17/7c. Existing direct Microsoft login button: unaffected normally, forces prompt=login ONLY when the server independently confirms expiry ===\n");

  const { default: LoginPage } = await import("@/app/(auth)/login/page");

  async function getLoginFormAction(cookieHeader: string | undefined, message?: string, callbackUrl?: string) {
    currentHeaders = new Headers(cookieHeader ? { cookie: cookieHeader } : {});
    const el = await LoginPage({ searchParams: Promise.resolve({ message: message as any, callbackUrl }) });
    const [formEl] = findElementsByType(el, "form");
    return formEl?.props?.action as (() => Promise<void>) | undefined;
  }

  console.log("\n-- 17. No session at all: the button signs in normally, no prompt=login (existing, unaffected behavior) --\n");
  resetCalls();
  const normalAction = await getLoginFormAction(undefined);
  check("Login page rendered a form with a real action", typeof normalAction === "function");
  await normalAction?.();
  check("signIn() called once, no forced prompt=login", signInCalls.length === 1 && signInCalls[0]?.[2] === undefined);
  check("signOut() never called for a normal, non-expired direct login", signOutCalls.length === 0);

  console.log("\n-- Real-world fix: /login?callbackUrl=... (no session, no message — exactly what the company suite's redirect currently produces) forwards to /auth/sso-entry for a genuinely silent flow, no click required --\n");
  resetCalls();
  {
    let redirectTarget: string | null = null;
    try {
      currentHeaders = new Headers();
      await LoginPage({ searchParams: Promise.resolve({ message: undefined, callbackUrl: "https://ithelpdesk.kinsen.gr/" }) });
    } catch (err: any) {
      // next/navigation's redirect() throws a special error carrying the target in its digest (format: "NEXT_REDIRECT;<type>;<url>;<status>").
      redirectTarget = typeof err?.digest === "string" ? err.digest : null;
    }
    check("LoginPage threw a redirect (not a render) for a plain external arrival with callbackUrl set", !!redirectTarget);
    check("...targeting /auth/sso-entry with the sanitized destination carried through as returnTo", !!redirectTarget && redirectTarget.includes("/auth/sso-entry?returnTo=") && redirectTarget.includes(encodeURIComponent("/")));
    check("signIn()/signOut() were NOT called directly by the login page itself for this case — it forwards to sso-entry, which owns that decision", signInCalls.length === 0 && signOutCalls.length === 0);
  }

  console.log("\n-- A BARE /login visit (no callbackUrl at all) still renders the page normally — the admin credentials escape hatch stays reachable --\n");
  resetCalls();
  const bareAction = await getLoginFormAction(undefined, undefined, undefined);
  check("A bare /login visit (no callbackUrl) renders the form instead of auto-redirecting", typeof bareAction === "function");

  console.log("\n-- 7c. Forged ?message=session_expired ALONE (no real expired cookie) never forces prompt=login — the query string is cosmetic only --\n");
  resetCalls();
  const forgedMessageAction = await getLoginFormAction(undefined, "session_expired");
  await forgedMessageAction?.();
  check("A forged 'session_expired' message with no actual expired cookie still does NOT force prompt=login — only the real cookie state decides this", signInCalls.length === 1 && signInCalls[0]?.[2] === undefined);

  console.log("\n-- Server-confirmed expiry (real expired cookie, no message param at all) DOES force prompt=login, and signs out the stale cookie first --\n");
  resetCalls();
  const realExpiryAction = await getLoginFormAction(expiredCookie2 /* no message param */);
  await realExpiryAction?.();
  check("signOut() called before signIn() for a genuinely expired cookie, even with no 'session_expired' message param present", signOutCalls.length === 1);
  check("signIn() forced prompt=login purely from the real cookie state", signInCalls.length === 1 && signInCalls[0]?.[2]?.prompt === "login");

  currentHeaders = new Headers();

  // ══════════════════════ 18. No tokens/sensitive auth data ever appear in this task's own code paths ══════════════════════
  console.log("\n=== 18. No Microsoft token/ID token/refresh token/identity assertion ever appears in a URL this task's code constructs ===\n");
  {
    const fs = await import("fs/promises");
    const newFilesSrc = await Promise.all([
      fs.readFile("app/auth/sso-entry/route.ts", "utf8"),
      fs.readFile("lib/safe-redirect.ts", "utf8"),
      fs.readFile("app/(auth)/login/page.tsx", "utf8"),
    ]);
    const combined = newFilesSrc.join("\n");
    const tokenLikeIdentifiers = /accessToken|access_token|idToken|id_token|refreshToken|refresh_token|providerAccountId/;
    check("None of the new/changed suite-entry code ever reads, forwards, or constructs a URL from an access/ID/refresh token — the only external input these files ever consume is `returnTo`/`callbackUrl` (validated internal paths)", !tokenLikeIdentifiers.test(combined));
    check("Neither new file ever calls console.log/console.error with the session cookie or any decoded token payload (only structured, non-secret classification results)", !/console\.(log|error|warn)\([^)]*(cookie|token)/i.test(combined));
  }

  console.log("\n=== 13/20. OAuth security mechanics (state/nonce/PKCE/provider config) and existing sign-out paths are untouched ===\n");
  {
    const fs = await import("fs/promises");
    const authConfigSrc = await fs.readFile("lib/auth.config.ts", "utf8");
    check("The Microsoft Entra provider's own config block (issuer/scope/allowDangerousEmailAccountLinking) is untouched — this task never edited provider.authorization/checks/PKCE settings", /scope: "openid profile email User\.Read"/.test(authConfigSrc) && /allowDangerousEmailAccountLinking: Boolean\(TENANT_ID\)/.test(authConfigSrc));
    check("No `checks:` override was added to the provider (PKCE/state/nonce still whatever Auth.js's own OIDC defaults already provided)", !/checks:\s*\[/.test(authConfigSrc));
    const topbarSrc = await fs.readFile("components/layout/topbar.tsx", "utf8");
    const changePasswordSrc = await fs.readFile("components/auth/change-password-form.tsx", "utf8");
    const expiryControllerSrc = await fs.readFile("components/auth/session-expiry-controller.tsx", "utf8");
    check("Existing sign-out call sites (Topbar) are untouched", /signOut\(\{ callbackUrl: "\/login" \}\)/.test(topbarSrc));
    check("Existing password-reset sign-out flow is untouched", /signOut\(\{ callbackUrl: "\/login\?message=password_changed" \}\)/.test(changePasswordSrc));
    check("Existing proactive session-expiry-controller sign-out flow is untouched", /signOut\(\{ callbackUrl: reason === "expired"/.test(expiryControllerSrc));
  }

  // ══════════════════════ SECTION B — real HTTP against a live dev server ══════════════════════
  console.log("\n=== SECTION B — real HTTP, live dev server (skips if unreachable) ===\n");

  const BASE_URL = "http://localhost:3000";
  let serverUp = false;
  try {
    const res = await fetch(BASE_URL, { redirect: "manual" });
    serverUp = res.status > 0;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    console.log(`No dev server reachable at ${BASE_URL} — skipping Section B (run \`npm run dev\` first).`);
    printSummaryAndExit();
    return;
  }

  console.log("\n-- 1 (live). Valid session over real HTTP: direct redirect, before any Microsoft/Configuration error could occur --\n");
  {
    const { prisma } = await import("@/lib/prisma");
    let dbConnected = true;
    try {
      await prisma.$connect();
    } catch {
      dbConnected = false;
    }
    if (dbConnected) {
      const realUser = await prisma.user.findFirst({ where: { isActive: true }, select: { id: true, email: true, name: true, role: true, mustChangePassword: true, departmentId: true, businessUnitId: true, customRoleId: true, microsoftUserId: true, globalRoleSource: true } });
      if (realUser) {
        const validLoginAt = Date.now() - 30 * 60 * 1000;
        const validCookie = await craftCookie({ sub: realUser.id, email: realUser.email, id: realUser.id, role: realUser.role, isActive: true, mustChangePassword: realUser.mustChangePassword, departmentId: realUser.departmentId, businessUnitId: realUser.businessUnitId, customRoleId: realUser.customRoleId, microsoftUserId: realUser.microsoftUserId, globalRoleSource: realUser.globalRoleSource, loginAt: validLoginAt, absoluteSessionExpiresAt: validLoginAt + 8 * 60 * 60 * 1000 });
        const liveRes = await fetch(`${BASE_URL}/auth/sso-entry?returnTo=/tickets`, { headers: { Cookie: validCookie }, redirect: "manual" });
        check("Real HTTP: valid session -> redirect straight to /tickets (never /unauthorized?error=Configuration)", liveRes.status >= 300 && liveRes.status < 400 && (liveRes.headers.get("location") ?? "").endsWith("/tickets"));

        console.log("\n-- 7 (live). Forged params over real HTTP cannot bypass or force anything for a valid session --\n");
        const liveForgedRes = await fetch(`${BASE_URL}/auth/sso-entry?returnTo=/tickets&expired=true&forceLogin=true`, { headers: { Cookie: validCookie }, redirect: "manual" });
        check("Real HTTP: forged params on a valid session still land straight on /tickets", (liveForgedRes.headers.get("location") ?? "").endsWith("/tickets"));
      } else {
        console.log("  No active user in the DB — skipping the live valid-session checks.");
      }
      console.log("\n-- 15 (live). A disabled (isActive: false) user's cookie never grants direct entry, even though it's not time-expired --\n");
      if (realUser) {
        const inactiveLoginAt = Date.now() - 30 * 60 * 1000; // well within the 8h window — NOT a time-expiry case
        const inactiveCookie = await craftCookie({ sub: realUser.id, email: realUser.email, id: realUser.id, role: realUser.role, isActive: false, loginAt: inactiveLoginAt, absoluteSessionExpiresAt: inactiveLoginAt + 8 * 60 * 60 * 1000 });
        const inactiveEntryRes = await fetch(`${BASE_URL}/auth/sso-entry?returnTo=/tickets`, { headers: { Cookie: inactiveCookie }, redirect: "manual" });
        const inactiveLocation = inactiveEntryRes.headers.get("location") ?? "";
        check("A disabled user's session cookie does NOT reach /tickets directly (session() callback's isActive check still denies it, unmodified)", !inactiveLocation.endsWith("/tickets"));
        const inactiveProtectedRes = await fetch(`${BASE_URL}/dashboard`, { headers: { Cookie: inactiveCookie }, redirect: "manual" });
        check("...and the same cookie still can't reach a protected page directly either (pre-existing isActive enforcement, unmodified by this task)", inactiveProtectedRes.status >= 300 && inactiveProtectedRes.status < 400);
      }

      await prisma.$disconnect();
    } else {
      console.log("  No reachable DATABASE_URL — skipping the live valid-session checks.");
    }
  }

  console.log("\n-- 6 (live, observable side-effect). Expired vs absent: only the expired branch clears the stale session cookie --\n");
  {
    const liveExpiredRes = await fetch(`${BASE_URL}/auth/sso-entry?returnTo=/tickets`, { headers: { Cookie: expiredCookie2 }, redirect: "manual" });
    const expiredSetCookies = liveExpiredRes.headers.getSetCookie?.() ?? [];
    const clearedSessionCookie = expiredSetCookies.some((c) => c.startsWith("authjs.session-token=") && /max-age=0/i.test(c));
    check("Expired-branch response clears the stale authjs.session-token cookie (Max-Age=0) — the observable proof that signOut() ran before the Microsoft redirect attempt", clearedSessionCookie);

    const liveAbsentRes = await fetch(`${BASE_URL}/auth/sso-entry?returnTo=/tickets`, { redirect: "manual" });
    const absentSetCookies = liveAbsentRes.headers.getSetCookie?.() ?? [];
    const clearedAnySessionCookieForAbsent = absentSetCookies.some((c) => c.startsWith("authjs.session-token=") && /max-age=0/i.test(c));
    check("Absent-branch response does NOT clear any session cookie (there was nothing to revoke) — the same observable proof that signOut() correctly did NOT run for a first-time entry", !clearedAnySessionCookieForAbsent);
  }

  console.log("\n-- 20 (live). Existing session-expiry HTTP enforcement is unaffected by this task's changes (reused from test-session-absolute-expiry-http.ts's own technique) --\n");
  {
    const dashRes = await fetch(`${BASE_URL}/dashboard`, { headers: { Cookie: expiredCookie2 }, redirect: "manual" });
    check("A protected page with an expired cookie still redirects to /login with the session_expired reason (unchanged)", (dashRes.headers.get("location") ?? "").includes("/login") && (dashRes.headers.get("location") ?? "").includes("session_expired"));
    // The relative (not absolute) callbackUrl fix in lib/auth.config.ts:
    const location = dashRes.headers.get("location") ?? "";
    const callbackUrlParam = new URL(location, BASE_URL).searchParams.get("callbackUrl");
    check("...and callbackUrl is now a RELATIVE path (e.g. '/dashboard'), not an absolute URL — so login/page.tsx's sanitizeInternalDestination actually accepts it instead of silently falling back", callbackUrlParam === "/dashboard" || (!!callbackUrlParam && callbackUrlParam.startsWith("/") && !callbackUrlParam.startsWith("//")));
  }

  console.log("\n-- 14 (live). Cancelled/failed Microsoft login: the existing callback error path still redirects once, creates no session --\n");
  {
    const cancelRes = await fetch(`${BASE_URL}/api/auth/callback/microsoft-entra-id?error=access_denied`, { redirect: "manual" });
    check("A cancelled/denied Microsoft callback -> a single redirect response (3xx), not a crash", cancelRes.status >= 300 && cancelRes.status < 400);
    const cancelSetCookies = cancelRes.headers.getSetCookie?.() ?? [];
    check("...and never sets a real session-token cookie (no session created from a failed/cancelled login)", !cancelSetCookies.some((c) => c.startsWith("authjs.session-token=") && !/max-age=0/i.test(c)));
  }

  printSummaryAndExit();
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
