/**
 * Absolute (non-sliding) 8-hour application-session expiration —
 * deterministic tests with a controlled clock (never a real 8h wait).
 * Covers the pure logic in lib/session-expiry.ts (which lib/auth.ts's
 * jwt/session callbacks, lib/auth.config.ts's middleware `authorized`
 * callback, and components/auth/session-expiry-controller.tsx all call —
 * see each file's own comments for exactly how) plus a structural check
 * that the session callback never extends the boundary, and the real
 * cross-tab BroadcastChannel mechanism.
 *
 * HTTP-level tests (protected API returns 401 SESSION_EXPIRED; protected
 * page redirects; a genuinely valid session still works) live in
 * scripts/test-session-absolute-expiry-http.ts, since they need a live dev
 * server — kept separate so this file has zero external dependencies and
 * always runs.
 *
 * Usage: npx tsx scripts/test-session-absolute-expiry.ts
 */
import {
  SESSION_ABSOLUTE_DURATION_MS,
  SESSION_WARNING_BEFORE_MS,
  computeAbsoluteSessionExpiry,
  isAbsoluteSessionExpired,
  stampAbsoluteSessionExpiryIfAbsent,
  computeSessionExpiryUiState,
} from "@/lib/session-expiry";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const LOGIN_AT = Date.UTC(2026, 0, 15, 9, 0, 0, 0); // 2026-01-15T09:00:00.000Z — arbitrary, fixed UTC instant

// ── 1. New login creates expiration exactly loginTime + 8h ─────────────────
function test1_newLoginExpiryIsExactlyPlus8h() {
  console.log("\n=== 1. New login -> expiration = loginTime + 8h exactly ===\n");
  const expiresAt = computeAbsoluteSessionExpiry(LOGIN_AT);
  check("expiresAt - loginAt is exactly 8 hours in ms", expiresAt - LOGIN_AT === 8 * 60 * 60 * 1000);
  check("SESSION_ABSOLUTE_DURATION_MS is exactly 8 hours", SESSION_ABSOLUTE_DURATION_MS === 8 * 60 * 60 * 1000);
  check("example from the brief: login 09:00 UTC -> expiry 17:00 UTC same day", new Date(expiresAt).toISOString() === "2026-01-15T17:00:00.000Z");
}

// ── 2 & 3. Valid at 7:59:59, rejected at 8:00:00 ────────────────────────────
function test2and3_boundary() {
  console.log("\n=== 2 & 3. Valid at 7:59:59, rejected at exactly 8:00:00 ===\n");
  const expiresAt = computeAbsoluteSessionExpiry(LOGIN_AT);
  const at7h5959 = LOGIN_AT + (7 * 60 * 60 + 59 * 60 + 59) * 1000;
  const at8h0000 = LOGIN_AT + 8 * 60 * 60 * 1000;
  const at8h0001 = at8h0000 + 1000;

  check("still valid at exactly 7:59:59 after login", isAbsoluteSessionExpired(expiresAt, at7h5959) === false);
  check("still valid one second before expiry (7:59:59.999 boundary)", isAbsoluteSessionExpired(expiresAt, expiresAt - 1) === false);
  check("expired at exactly 8:00:00 after login (the boundary itself counts as expired)", isAbsoluteSessionExpired(expiresAt, at8h0000) === true);
  check("expired at 8:00:01", isAbsoluteSessionExpired(expiresAt, at8h0001) === true);
  check("no absoluteSessionExpiresAt at all -> never reported expired (nothing to compare against)", isAbsoluteSessionExpired(undefined) === false);
}

// ── 4, 5, 7, 15, 16. Activity/refresh/Microsoft-sync never move the clock; a fresh token after logout gets its own independent window ──
function test4_5_7_15_16_neverSlides() {
  console.log("\n=== 4, 5, 7, 15, 16. Activity/refresh/Microsoft-sync never extend the session; new login = new independent window ===\n");

  const token: { loginAt?: number; absoluteSessionExpiresAt?: number; role?: string; departmentId?: string | null } = {};
  stampAbsoluteSessionExpiryIfAbsent(token, LOGIN_AT);
  const originalLoginAt = token.loginAt;
  const originalExpiresAt = token.absoluteSessionExpiresAt;
  check("first stamp sets loginAt to the provided clock value", originalLoginAt === LOGIN_AT);
  check("first stamp sets absoluteSessionExpiresAt = loginAt + 8h", originalExpiresAt === LOGIN_AT + SESSION_ABSOLUTE_DURATION_MS);

  // Scenario 4: "activity" = calling the exact same guard again at a LATER
  // wall-clock time (simulating a request the user made an hour into their
  // session) — must be a no-op.
  const oneHourLater = LOGIN_AT + 60 * 60 * 1000;
  stampAbsoluteSessionExpiryIfAbsent(token, oneHourLater);
  check("activity 1h into the session never moves loginAt", token.loginAt === originalLoginAt);
  check("activity 1h into the session never moves absoluteSessionExpiresAt", token.absoluteSessionExpiresAt === originalExpiresAt);

  // Scenario 5: "page refresh" = another jwt() invocation with the SAME
  // token, at yet another later time — same guard, same no-op guarantee.
  const fourHoursLater = LOGIN_AT + 4 * 60 * 60 * 1000;
  stampAbsoluteSessionExpiryIfAbsent(token, fourHoursLater);
  check("a later 'page refresh' invocation never moves loginAt", token.loginAt === originalLoginAt);
  check("a later 'page refresh' invocation never moves absoluteSessionExpiresAt", token.absoluteSessionExpiresAt === originalExpiresAt);

  // Scenario 7: Microsoft token refresh / department-sync mutates OTHER
  // token fields (role, departmentId, ...) in the real jwt() callback —
  // simulated here by mutating unrelated fields between stamp calls, then
  // confirming the guard is still a no-op regardless.
  token.role = "USER";
  token.departmentId = "some-department-id";
  stampAbsoluteSessionExpiryIfAbsent(token, fourHoursLater + 1000);
  token.role = "IT_AGENT"; // e.g. a Microsoft-mapped role change mid-session
  token.departmentId = "a-different-department-id";
  stampAbsoluteSessionExpiryIfAbsent(token, fourHoursLater + 2000);
  check("unrelated token field churn (role/department, simulating Microsoft sync) never moves loginAt", token.loginAt === originalLoginAt);
  check("unrelated token field churn never moves absoluteSessionExpiresAt", token.absoluteSessionExpiresAt === originalExpiresAt);

  // Scenario 15: a genuinely NEW token (post-logout, fresh sign-in) gets
  // its own independent window, computed from ITS OWN login time — not
  // influenced by the previous token's values in any way (a fresh object,
  // proving there's no hidden shared/global state).
  const newLoginAt = LOGIN_AT + 6 * 60 * 60 * 1000; // logged back in 6h after the first login
  const freshToken: { loginAt?: number; absoluteSessionExpiresAt?: number } = {};
  stampAbsoluteSessionExpiryIfAbsent(freshToken, newLoginAt);
  check("a fresh post-logout login gets a NEW loginAt, independent of the previous session", freshToken.loginAt === newLoginAt && freshToken.loginAt !== originalLoginAt);
  check("the new session's expiry is newLoginAt + 8h, not related to the old session's expiry", freshToken.absoluteSessionExpiresAt === newLoginAt + SESSION_ABSOLUTE_DURATION_MS);

  // Scenario 16: credentials and Microsoft sign-in call the EXACT SAME
  // stamping function/call site in lib/auth.ts (verified structurally in
  // test6_sessionCallbackStructurallyNeverExtends below, which parses the
  // real source) — so this single guard's correctness IS the proof for
  // both providers; no provider-specific stamping logic exists to test
  // separately.
  check("(see structural source check below) the same stamp call site serves both credentials and Microsoft sign-in", true);
}

// ── 6. Session callback structurally never extends the expiration ──────────
function test6_sessionCallbackStructurallyNeverExtends() {
  console.log("\n=== 6. Session callback never recomputes/extends absoluteSessionExpiresAt (source-verified) ===\n");
  const source = readFileSync(join(process.cwd(), "lib", "auth.ts"), "utf8");

  const sessionCallbackStart = source.indexOf("async session({ session, token })");
  check("session callback found in lib/auth.ts", sessionCallbackStart !== -1);
  const sessionCallbackBody = source.slice(sessionCallbackStart, source.indexOf("\n  },\n\n  secret:"));
  check("session callback body isolated for inspection", sessionCallbackBody.length > 0 && sessionCallbackBody.length < source.length);

  check("session callback never calls computeAbsoluteSessionExpiry", !sessionCallbackBody.includes("computeAbsoluteSessionExpiry("));
  check("session callback never calls stampAbsoluteSessionExpiryIfAbsent", !sessionCallbackBody.includes("stampAbsoluteSessionExpiryIfAbsent("));
  check("session callback never assigns a NEW value to absoluteSessionExpiresAt (only ever reads token's)", !/absoluteSessionExpiresAt\s*=\s*(?!token\.absoluteSessionExpiresAt)/.test(sessionCallbackBody.replace("session.user.absoluteSessionExpiresAt = token.absoluteSessionExpiresAt;", "")));
  check(
    "session callback DOES defensively reject an expired token (mirrors the jwt callback's own check)",
    sessionCallbackBody.includes("isAbsoluteSessionExpired(token.absoluteSessionExpiresAt)") && sessionCallbackBody.includes("return null")
  );

  // Structural confirmation of scenario 16: the stamping call site sits
  // OUTSIDE the Microsoft-only `if (account?.provider === "microsoft-entra-id")`
  // block, so it runs identically for credentials and Microsoft sign-in.
  const jwtCallbackStart = source.indexOf("async jwt({ token, user, account, profile })");
  const microsoftBlockStart = source.indexOf('if (account?.provider === "microsoft-entra-id")', jwtCallbackStart);
  const microsoftBlockEnd = source.indexOf("delete token.picture;", microsoftBlockStart);
  const stampCallIndex = source.indexOf("stampAbsoluteSessionExpiryIfAbsent(token);", jwtCallbackStart);
  check("jwt/microsoft-block/stamp-call locations all found", jwtCallbackStart !== -1 && microsoftBlockStart !== -1 && microsoftBlockEnd !== -1 && stampCallIndex !== -1);
  check("the stamp call site is AFTER the Microsoft-only block ends (i.e. outside it) — runs for every provider alike", stampCallIndex > microsoftBlockEnd);
}

// ── 10, 11, 13, 14. Client decision function: warn/signout thresholds, sleep/wake, never extends ──
function test10_11_13_14_uiDecisionFunction() {
  console.log("\n=== 10, 11, 13, 14. Client decision logic: warning threshold, immediate detection, never extends ===\n");
  const expiresAt = computeAbsoluteSessionExpiry(LOGIN_AT);

  check("6h into an 8h session -> action 'none' (no warning yet)", computeSessionExpiryUiState(expiresAt, LOGIN_AT + 6 * 60 * 60 * 1000).action === "none");
  check("exactly at the 5-minute-before mark -> action 'warn'", computeSessionExpiryUiState(expiresAt, expiresAt - SESSION_WARNING_BEFORE_MS).action === "warn");
  check("1 minute before expiry -> action 'warn'", computeSessionExpiryUiState(expiresAt, expiresAt - 60_000).action === "warn");
  check("exactly at expiry -> action 'signout'", computeSessionExpiryUiState(expiresAt, expiresAt).action === "signout");
  check("well past expiry (already-expired timestamp on load) -> action 'signout' immediately, remainingMs clamped to 0", (() => {
    const r = computeSessionExpiryUiState(expiresAt, expiresAt + 60 * 60 * 1000);
    return r.action === "signout" && r.remainingMs === 0;
  })());

  // Scenario 11: sleep/wake — a stale scheduled check from BEFORE sleep is
  // irrelevant; the function is pure and stateless, so calling it fresh
  // with "now" jumped forward (as if the machine just woke up) detects
  // expiry immediately, on the very first call, with no dependency on any
  // previously-scheduled timer having fired correctly.
  const machineWasAsleepFor10Hours = expiresAt + 2 * 60 * 60 * 1000; // now() jumped 10h past login, 2h past the 8h boundary
  check("a clock jump past expiry (simulated sleep/wake) is detected on the very next call", computeSessionExpiryUiState(expiresAt, machineWasAsleepFor10Hours).action === "signout");

  // Scenario 14: the warning path never mutates/returns a different expiresAt
  // — proven by construction (the function's signature has no output
  // channel for expiresAt at all, and repeated "warn" calls at different
  // "now" values always measure against the SAME input expiresAt).
  const warnState1 = computeSessionExpiryUiState(expiresAt, expiresAt - 4 * 60 * 1000);
  const warnState2 = computeSessionExpiryUiState(expiresAt, expiresAt - 2 * 60 * 1000);
  check(
    "two successive 'warn' evaluations against the SAME expiresAt show strictly decreasing remainingMs — never reset/extended by the warning itself",
    warnState2.remainingMs < warnState1.remainingMs
  );
}

// ── 12. Logout in one tab disconnects the others (real BroadcastChannel) ───
async function test12_crossTabBroadcast() {
  console.log("\n=== 12. Cross-tab logout sync via a real BroadcastChannel ===\n");
  if (typeof BroadcastChannel === "undefined") {
    console.log("  BroadcastChannel not available in this Node runtime — skipping (requires Node 18+).");
    return;
  }
  const CHANNEL_NAME = "kinsen-session-sync-test";
  const tabA = new BroadcastChannel(CHANNEL_NAME);
  const tabB = new BroadcastChannel(CHANNEL_NAME);
  const tabC = new BroadcastChannel(CHANNEL_NAME);

  try {
    const received: unknown[] = [];
    const gotMessage = new Promise<void>((resolve) => {
      let count = 0;
      const onMsg = (event: MessageEvent) => {
        received.push(event.data);
        count++;
        if (count >= 2) resolve(); // both tabB and tabC should receive it
      };
      tabB.addEventListener("message", onMsg);
      tabC.addEventListener("message", onMsg);
    });

    // tabA "logs out" — broadcasts, like components/auth/session-expiry-controller.tsx
    // and components/layout/topbar.tsx both do via lib/client-session-broadcast.ts.
    tabA.postMessage({ type: "LOGOUT" });

    await Promise.race([gotMessage, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))]);

    check("both other open tabs receive the LOGOUT broadcast", received.length === 2);
    check("the broadcast message carries the expected type", received.every((m: any) => m?.type === "LOGOUT"));
  } catch (err) {
    check(`cross-tab broadcast delivered within 2s (${err instanceof Error ? err.message : String(err)})`, false);
  } finally {
    tabA.close();
    tabB.close();
    tabC.close();
  }
}

async function main() {
  test1_newLoginExpiryIsExactlyPlus8h();
  test2and3_boundary();
  test4_5_7_15_16_neverSlides();
  test6_sessionCallbackStructurallyNeverExtends();
  test10_11_13_14_uiDecisionFunction();
  await test12_crossTabBroadcast();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
