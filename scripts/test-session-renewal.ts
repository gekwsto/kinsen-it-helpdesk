/**
 * Session renewal by re-authentication — unit + route-level checks:
 *  1. Pure helpers: isValidSessionRenewal, warning timing for a renewed
 *     expiry, final-notice threshold.
 *  2. Policy unchanged: a token refresh/update never extends the absolute
 *     expiry; only a NEW sign-in (fresh token) gets a new one.
 *  3. GET /auth/session-renew: requires a session; Microsoft users ->
 *     existing Entra sign-in hinted to their own account; credentials users
 *     -> the credentials renewal page; the renewal identity cookie is set;
 *     returnTo is sanitized.
 *  4. checkSessionRenewalIdentity: only the SAME user may complete a renewal;
 *     the marker is consumed.
 *
 * Usage: node --require ./scripts/test-support-server-only-stub.cjs --experimental-test-module-mocks --import tsx scripts/test-session-renewal.ts
 */
import { mock } from "node:test";
import { prisma } from "@/lib/prisma";
import { AuthProvider, Role } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Mocked request-scope cookie jar + auth() / signIn().
const jar = new Map<string, { value: string; opts?: any }>();
// The request's session cookie header (the renewal marker is only enforced while a session is present).
let sessionCookieHeader = "";
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
      set: (name: string, value: string, opts?: any) => { jar.set(name, { value, opts }); },
      delete: (name: string) => { jar.delete(name); },
    }),
    headers: async () => new Headers(sessionCookieHeader ? { cookie: sessionCookieHeader } : {}),
  },
});
let currentSession: any = null;
const signInCalls: any[] = [];
class RedirectSignal extends Error {}
mock.module("@/lib/auth", {
  namedExports: {
    auth: async () => currentSession,
    signIn: async (...args: any[]) => { signInCalls.push(args); throw new RedirectSignal("NEXT_REDIRECT (signIn)"); },
    signOut: async () => {},
    handlers: {},
  },
});

const RUN_ID = Date.now();

async function main() {
  const se = await import("@/lib/session-expiry");
  const { NextRequest } = await import("next/server");
  const { GET: renewGET } = await import("@/app/auth/session-renew/route");
  const { checkSessionRenewalIdentity, clearSessionRenewal, encodeSessionRenewalMarker, SESSION_RENEWAL_COOKIE, SESSION_RENEWAL_MAX_AGE_MS } = await import("@/lib/session-renewal");
  const userIds: string[] = [];

  try {
    console.log("\n=== 1. Pure helpers ===\n");
    const now = Date.UTC(2026, 10, 26, 10, 0, 0);
    const oldExp = now + 4 * 60_000;
    const renewedExp = now + se.SESSION_ABSOLUTE_DURATION_MS;
    check("1.1 A later, outside-the-warning-window expiry is a valid renewal", se.isValidSessionRenewal(oldExp, renewedExp, now));
    check("1.2 The SAME (old) expiry is not a renewal", !se.isValidSessionRenewal(oldExp, oldExp, now));
    check("1.3 An earlier expiry is not a renewal", !se.isValidSessionRenewal(oldExp, oldExp - 1, now));
    check("1.4 A later expiry still inside the warning window is not accepted (old warning can't persist)", !se.isValidSessionRenewal(oldExp, now + 4.5 * 60_000, now));
    check("1.5 Missing/invalid renewed expiry is not a renewal", !se.isValidSessionRenewal(oldExp, null, now) && !se.isValidSessionRenewal(oldExp, Number.NaN, now));
    check("1.6 Right after renewal: no warning (action none)", se.computeSessionExpiryUiState(renewedExp, now).action === "none");
    check("1.7 The warning appears again 5 minutes before the RENEWED expiry", se.computeSessionExpiryUiState(renewedExp, renewedExp - se.SESSION_WARNING_BEFORE_MS + 1).action === "warn" && se.computeSessionExpiryUiState(renewedExp, renewedExp - se.SESSION_WARNING_BEFORE_MS - 1).action === "none");
    check("1.8 ...and the renewed session signs out exactly at its own expiry", se.computeSessionExpiryUiState(renewedExp, renewedExp).action === "signout");
    check("1.9 Final notice threshold (1 minute) sits inside the warning window", se.SESSION_FINAL_NOTICE_BEFORE_MS === 60_000 && se.SESSION_FINAL_NOTICE_BEFORE_MS < se.SESSION_WARNING_BEFORE_MS);

    console.log("\n=== 2. Policy unchanged: absolute 8h, extended only by a NEW sign-in ===\n");
    const existing = { loginAt: now - 7 * 3600_000, absoluteSessionExpiresAt: now + 3600_000 };
    const refreshed = se.stampAbsoluteSessionExpiryIfAbsent({ ...existing }, now);
    check("2.1 Refresh/update of an existing token never changes its expiry (no sliding)", refreshed.absoluteSessionExpiresAt === existing.absoluteSessionExpiresAt && refreshed.loginAt === existing.loginAt);
    const freshSignIn = se.stampAbsoluteSessionExpiryIfAbsent({} as { loginAt?: number; absoluteSessionExpiresAt?: number }, now);
    check("2.2 A new sign-in's fresh token gets a new absolute expiry of exactly 8h from that sign-in", freshSignIn.loginAt === now && freshSignIn.absoluteSessionExpiresAt === now + 8 * 3600_000);
    check("2.3 Session duration constant unchanged (8h)", se.SESSION_ABSOLUTE_DURATION_MS === 8 * 60 * 60 * 1000);

    console.log("\n=== 3. GET /auth/session-renew ===\n");
    const ms = await prisma.user.create({ data: { email: `renew-ms-${RUN_ID}@kinsen.gr`, name: "Renew MS", role: Role.USER, authProvider: AuthProvider.MICROSOFT, isActive: true } });
    const cred = await prisma.user.create({ data: { email: `renew-cred-${RUN_ID}@kinsen.gr`, name: "Renew Cred", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    const other = await prisma.user.create({ data: { email: `renew-other-${RUN_ID}@kinsen.gr`, name: "Renew Other", role: Role.ADMIN, authProvider: AuthProvider.CREDENTIALS, isActive: true } });
    userIds.push(ms.id, cred.id, other.id);
    const call = async (qs = "") => {
      try { return await renewGET(new NextRequest(`http://localhost:3000/auth/session-renew${qs}`)); } catch (e) { if (e instanceof RedirectSignal) return "signIn-redirect" as const; throw e; }
    };

    currentSession = null; jar.clear(); signInCalls.length = 0;
    const noSession = await call();
    check("3.1 Without a valid session → /login?message=session_expired, no sign-in started, no renewal marker", noSession !== "signIn-redirect" && noSession?.headers.get("location")?.endsWith("/login?message=session_expired") === true && signInCalls.length === 0 && !jar.has(SESSION_RENEWAL_COOKIE));

    currentSession = { user: { id: ms.id, email: ms.email } }; jar.clear(); signInCalls.length = 0;
    const msRes = await call();
    check("3.2 Microsoft user → the existing Entra ID sign-in, back to /auth/session-renewed", msRes === "signIn-redirect" && signInCalls[0]?.[0] === "microsoft-entra-id" && signInCalls[0]?.[1]?.redirectTo === "/auth/session-renewed");
    check("3.3 ...hinted to the user's own account (login_hint), never forcing a different-account prompt", signInCalls[0]?.[2]?.login_hint === ms.email && signInCalls[0]?.[2]?.prompt === undefined);
    const marker = jar.get(SESSION_RENEWAL_COOKIE);
    check("3.4 ...and the renewal identity marker is set: httpOnly, lax, short-lived, naming THIS user (with its issue time)", /^.+\.\d+$/.test(marker?.value ?? "") && marker!.value.startsWith(`${ms.id}.`) && marker?.opts?.httpOnly === true && marker?.opts?.sameSite === "lax" && marker?.opts?.maxAge === 600);

    currentSession = { user: { id: ms.id, email: ms.email } }; jar.clear(); signInCalls.length = 0;
    await call(`?returnTo=${encodeURIComponent("/projects/abc?tab=1")}`);
    check("3.5 Same-tab fallback keeps an internal returnTo", signInCalls[0]?.[1]?.redirectTo === `/auth/session-renewed?returnTo=${encodeURIComponent("/projects/abc?tab=1")}`);
    jar.clear(); signInCalls.length = 0;
    await call(`?returnTo=${encodeURIComponent("https://evil.example/x")}`);
    check("3.6 ...and an external returnTo is sanitized away (open-redirect safe)", !String(signInCalls[0]?.[1]?.redirectTo).includes("evil.example"), String(signInCalls[0]?.[1]?.redirectTo));

    currentSession = { user: { id: cred.id, email: cred.email } }; jar.clear(); signInCalls.length = 0;
    const credRes = await call();
    check("3.7 Credentials (admin) user → the credentials renewal page, no Microsoft round-trip", credRes !== "signIn-redirect" && credRes?.headers.get("location")?.includes("/auth/session-renew/credentials?next=%2Fauth%2Fsession-renewed") === true && signInCalls.length === 0 && jar.get(SESSION_RENEWAL_COOKIE)?.value.startsWith(`${cred.id}.`) === true);

    console.log("\n=== 4. Renewal identity binding (signIn callback check) ===\n");
    const { encode } = await import("next-auth/jwt");
    if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET not set (source .env)");
    sessionCookieHeader = `authjs.session-token=${await encode({ token: { sub: cred.id, email: cred.email, loginAt: Date.now(), absoluteSessionExpiresAt: Date.now() + 3600_000 }, secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 8 * 3600 })}`;
    jar.clear();
    check("4.1 No renewal in progress → normal sign-in unaffected", (await checkSessionRenewalIdentity({ id: other.id, email: other.email })).renewing === false);
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id) });
    const same = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
    check("4.2 Renewal by the SAME user (by id) → allowed", same.renewing && same.sameUser);
    check("4.3 ...and the marker is consumed", !jar.has(SESSION_RENEWAL_COOKIE));
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(ms.id) });
    const sameByEmail = await checkSessionRenewalIdentity({ id: "provider-profile-id", email: ms.email.toUpperCase() });
    check("4.4 OAuth sign-in identified by email (case-insensitive) → allowed", sameByEmail.renewing && sameByEmail.sameUser);
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id) });
    const diff = await checkSessionRenewalIdentity({ id: other.id, email: other.email });
    check("4.5 A DIFFERENT account during renewal → rejected (no account linking / session swap)", diff.renewing && !diff.sameUser);
    await prisma.user.update({ where: { id: cred.id }, data: { isActive: false } });
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id) });
    const inactive = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
    check("4.6 A since-deactivated user can't renew", inactive.renewing && !inactive.sameUser);
    await prisma.user.update({ where: { id: cred.id }, data: { isActive: true } });

    console.log("\n=== 5. Renewal state expires and can't be replayed or forged ===\n");
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id) });
    const first = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
    const replay = await checkSessionRenewalIdentity({ id: other.id, email: other.email });
    check("5.1 Single use: after one sign-in consumed it, the marker is gone — a second sign-in is not a renewal", first.renewing && first.sameUser && replay.renewing === false && !jar.has(SESSION_RENEWAL_COOKIE));
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id, Date.now() - SESSION_RENEWAL_MAX_AGE_MS - 1000) });
    const stale = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
    check("5.2 Server-side expiry: a marker older than 10 minutes is REFUSED even for the same user (fail safe), and consumed", stale.renewing && !stale.sameUser && stale.expired === true && !jar.has(SESSION_RENEWAL_COOKIE));
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id, Date.now() + 10 * 60_000) });
    const future = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
    check("5.3 A future-dated (tampered) marker is refused", future.renewing && !future.sameUser && future.expired === true);
    for (const bad of [cred.id, "garbage", `${cred.id}.notanumber`, ".123"]) {
      jar.set(SESSION_RENEWAL_COOKIE, { value: bad });
      const r = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
      check(`5.4 Malformed marker "${bad.slice(0, 12)}…" is refused (never treated as a normal sign-in)`, r.renewing && !r.sameUser);
    }
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(other.id) });
    const forgedForOther = await checkSessionRenewalIdentity({ id: cred.id, email: cred.email });
    check("5.5 A marker naming someone else only RESTRICTS: the signing-in user is refused, nothing is granted", forgedForOther.renewing && !forgedForOther.sameUser);
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id) });
    await clearSessionRenewal();
    check("5.6 Sign-out clears a pending marker (events.signOut → clearSessionRenewal)", !jar.has(SESSION_RENEWAL_COOKIE));
    // Session already gone (expired + cleared, or signed out without the event): a leftover marker is inert.
    const savedCookie = sessionCookieHeader;
    sessionCookieHeader = "";
    jar.set(SESSION_RENEWAL_COOKIE, { value: encodeSessionRenewalMarker(cred.id) });
    const leftover = await checkSessionRenewalIdentity({ id: other.id, email: other.email });
    check("5.8 With NO session present, a leftover marker is inert (consumed, normal sign-in for anyone) — it can't affect the next person", leftover.renewing === false && !jar.has(SESSION_RENEWAL_COOKIE));
    sessionCookieHeader = savedCookie;
    const authSrc = await (await import("node:fs/promises")).readFile("lib/auth.ts", "utf8");
    check("5.7 ...wired into NextAuth's signOut event", /events:\s*\{[\s\S]*?async signOut\(\)\s*\{[\s\S]*?clearSessionRenewal\(\)/.test(authSrc));
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
