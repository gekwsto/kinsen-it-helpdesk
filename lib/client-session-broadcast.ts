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

export interface SessionSyncMessage {
  type: "LOGOUT";
}

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
