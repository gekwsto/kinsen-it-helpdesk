"use client";

/**
 * Cross-tab logout synchronization — one tiny shared module so both
 * components/auth/session-expiry-controller.tsx (automatic 8h expiry) and
 * components/layout/topbar.tsx (manual "Sign out" click) broadcast/react to
 * the exact same channel and message shape, instead of each inventing its
 * own. `BroadcastChannel` is used directly (well-supported in every browser
 * this app targets) rather than a `storage`-event polyfill — if it's ever
 * unavailable (very old browser, or a non-browser test environment), every
 * function here degrades to a safe no-op rather than throwing; the
 * server-side session check remains the actual security boundary either
 * way — this is a same-origin UX convenience, never relied on for
 * enforcement.
 */

const CHANNEL_NAME = "kinsen-session-sync";

export type SessionSyncMessage =
  | { type: "LOGOUT" }
  // Posted by the session-renewal popup (app/auth/session-renewed) after a
  // genuine re-authentication issued a fresh session cookie. Carries no
  // authority of its own: every receiving tab re-reads its session from
  // the SERVER and validates it (same user, later expiry) before trusting it.
  | { type: "SESSION_RENEWED"; userId: string; absoluteSessionExpiresAt: number }
  // The renewal sign-in was refused/failed (e.g. a different account) — the
  // existing session is untouched; waiting tabs show a clear message.
  | { type: "SESSION_RENEWAL_FAILED"; reason: string };

export function getSessionSyncChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

/** Tells every OTHER tab listening on the channel to sign out too — never call this from the tab that's reacting to an incoming message (that would echo forever). */
export function broadcastLogout(channel: BroadcastChannel | null): void {
  try {
    channel?.postMessage({ type: "LOGOUT" } satisfies SessionSyncMessage);
  } catch {
    // Best-effort only — a failed broadcast never blocks the local sign-out.
  }
}

/** Announces a completed session renewal to every OTHER browsing context (each re-validates against the server). */
export function broadcastSessionRenewed(channel: BroadcastChannel | null, userId: string, absoluteSessionExpiresAt: number): void {
  try {
    channel?.postMessage({ type: "SESSION_RENEWED", userId, absoluteSessionExpiresAt } satisfies SessionSyncMessage);
  } catch {
    // Same as broadcastLogout: a closed/unsupported channel is never fatal.
  }
}

export function broadcastSessionRenewalFailed(channel: BroadcastChannel | null, reason: string): void {
  try {
    channel?.postMessage({ type: "SESSION_RENEWAL_FAILED", reason } satisfies SessionSyncMessage);
  } catch {
    // never fatal
  }
}
