/**
 * Absolute (non-sliding) application-session expiration — shared, edge-safe
 * constants and helpers. Imported from BOTH `lib/auth.ts` (Node runtime,
 * full NextAuth config with Prisma) and `lib/auth.config.ts` (Edge runtime,
 * used directly by `middleware.ts`) — deliberately has NO Prisma import and
 * no Node-only API, so it stays usable from both.
 *
 * Why this exists at all (see lib/auth.ts's jwt/session callbacks for the
 * full explanation): Auth.js's own `@auth/core` JWT-session implementation
 * re-signs the session cookie (via `jwt.encode()`, which unconditionally
 * sets `exp = now + maxAge`) on EVERY session read — every Server Component
 * `auth()` call, every middleware pass, every `SessionProvider` focus-
 * refetch. That is genuine, built-in sliding expiration; setting
 * `session.maxAge`/`jwt.maxAge` alone only caps how far each individual
 * slide can reach, it does not stop the sliding itself. The fix is a
 * separate, application-level absolute timestamp — computed once at login,
 * carried unmodified inside the JWT payload (which Auth.js's re-signing
 * does NOT alter, only the JWT's own outer `exp` claim), and explicitly
 * checked on every read.
 */

/** Absolute application-session duration — 8 hours, in milliseconds. */
export const SESSION_ABSOLUTE_DURATION_MS = 8 * 60 * 60 * 1000;

/** Same duration in seconds, for Auth.js's `session.maxAge`/`jwt.maxAge` (which take seconds). */
export const SESSION_ABSOLUTE_DURATION_SECONDS = SESSION_ABSOLUTE_DURATION_MS / 1000;

/**
 * `loginAt` is always epoch milliseconds (UTC by construction — `Date.now()`
 * is UTC-based, never local time), computed exactly once per real sign-in.
 */
export function computeAbsoluteSessionExpiry(loginAtMs: number): number {
  return loginAtMs + SESSION_ABSOLUTE_DURATION_MS;
}

/**
 * The server-side, authoritative check — a plain, exact `now >= expiresAt`
 * comparison, deliberately with NO grace period. The brief explicitly asks
 * for tolerance only where "technically necessary" and never as a session
 * extension; this single Node/Edge process has one system clock, so there
 * is no cross-service clock-skew problem to compensate for here. (The
 * client-side controller has its own, purely UX-facing slack — see
 * components/auth/session-expiry-controller.tsx — which never feeds back
 * into this authoritative check.)
 */
export function isAbsoluteSessionExpired(absoluteSessionExpiresAt: number | null | undefined, nowMs: number = Date.now()): boolean {
  if (typeof absoluteSessionExpiresAt !== "number" || !Number.isFinite(absoluteSessionExpiresAt)) return false;
  return nowMs >= absoluteSessionExpiresAt;
}

/**
 * The entire "no sliding expiration" guarantee lives in this one guard —
 * extracted as its own, directly unit-testable function (same rationale as
 * this codebase's existing `handleMicrosoftJwtSignIn` extraction: the real
 * `jwt()` callback in lib/auth.ts is embedded inside the `NextAuth(...)`
 * factory call and isn't independently invocable, so the logic that needs
 * to be provably correct is pulled out here instead of tested indirectly).
 *
 * Called on EVERY `jwt()` callback invocation where `user?.email` is
 * truthy (Auth.js's own signal for "this is an actual sign-in", never a
 * plain token-refresh/session-read — see lib/auth.ts). If `loginAt` is
 * already set, this is a no-op: activity, page refreshes, Microsoft
 * account/token data, and repeated invocations of this exact function all
 * leave `loginAt`/`absoluteSessionExpiresAt` byte-for-byte unchanged. Only
 * a token that has genuinely never been stamped gets one, computed from
 * `nowMs` (defaults to `Date.now()`, overridable so callers/tests can pass
 * a controlled clock).
 */
export function stampAbsoluteSessionExpiryIfAbsent<T extends { loginAt?: number; absoluteSessionExpiresAt?: number }>(
  token: T,
  nowMs: number = Date.now()
): T {
  if (!token.loginAt) {
    token.loginAt = nowMs;
    token.absoluteSessionExpiresAt = computeAbsoluteSessionExpiry(nowMs);
  }
  return token;
}

/** 5 minutes before the authoritative server expiry — shared by the pure decision function below and the component that renders it, so there is exactly one place this number is defined. */
export const SESSION_WARNING_BEFORE_MS = 5 * 60 * 1000;

export type SessionExpiryUiAction = "none" | "warn" | "signout";

export interface SessionExpiryUiState {
  action: SessionExpiryUiAction;
  remainingMs: number;
}

/**
 * The ENTIRE decision logic behind
 * components/auth/session-expiry-controller.tsx — deliberately pure (no
 * timers, no DOM, no React) so it's directly unit-testable with a
 * controlled clock, matching how `isAbsoluteSessionExpired` is tested.
 * `expiresAt` is always the authoritative, server-computed value (never
 * recomputed here); `nowMs` defaults to `Date.now()` so the real component
 * can call this with no arguments while a test passes a controlled value —
 * this is also exactly why "sleep/wake" and "returning to a hidden tab"
 * are handled correctly by construction: every call is a fresh,
 * independent comparison against the current clock, never dependent on
 * whatever a previously-scheduled timer assumed "now" would be.
 */
export function computeSessionExpiryUiState(expiresAt: number, nowMs: number = Date.now()): SessionExpiryUiState {
  const remainingMs = expiresAt - nowMs;
  if (remainingMs <= 0) return { action: "signout", remainingMs: 0 };
  if (remainingMs <= SESSION_WARNING_BEFORE_MS) return { action: "warn", remainingMs };
  return { action: "none", remainingMs };
}

export interface RawSessionExpiryState {
  /** A session cookie was present and successfully decrypted at all. */
  hasToken: boolean;
  absoluteSessionExpiresAt: number | null;
  isExpired: boolean;
}

/**
 * Decodes the request's session cookie DIRECTLY via `next-auth/jwt`'s
 * `getToken` — bypassing the `jwt()`/`session()` callback pipeline entirely
 * (no re-signing, no side effects, no cookie writes). This exists for
 * exactly one reason: our own `jwt()` callback (lib/auth.ts) returns `null`
 * once the absolute expiry has passed, which makes `auth()` resolve to
 * `null` — indistinguishable, from the caller's point of view, from "never
 * signed in at all". Callers that need to tell those two cases apart
 * (middleware's `authorized()` callback, to return the specific
 * `SESSION_EXPIRED` contract instead of a generic redirect; `requireAuth()`,
 * for the same reason server-side) use this raw decode instead. Edge-safe
 * (no Node-only API), matching this module's other exports. Never throws —
 * any decode failure is reported as "no token", never surfaced as an error.
 */
export async function readRawSessionExpiryState(req: { headers: Headers | Record<string, string> }): Promise<RawSessionExpiryState> {
  const empty: RawSessionExpiryState = { hasToken: false, absoluteSessionExpiresAt: null, isExpired: false };
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return empty;
    // Dynamic import keeps this module importable from contexts that never
    // need it without pulling in next-auth/jwt eagerly — harmless either
    // way given this module already assumes a next-auth environment, but
    // costs nothing to keep the dependency lazy here.
    const { getToken } = await import("next-auth/jwt");
    const raw = await getToken({
      req,
      secret,
      secureCookie: process.env.NODE_ENV === "production",
    });
    if (!raw) return empty;
    const expiresAt = typeof raw.absoluteSessionExpiresAt === "number" ? raw.absoluteSessionExpiresAt : null;
    return { hasToken: true, absoluteSessionExpiresAt: expiresAt, isExpired: isAbsoluteSessionExpired(expiresAt) };
  } catch {
    return empty;
  }
}
