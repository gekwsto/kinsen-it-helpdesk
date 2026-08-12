/**
 * Pure, framework-independent decision points extracted out of
 * components/notifications/notification-dropdown.tsx's push enable/disable
 * flow — directly unit-testable without a browser/DOM (this repo's test
 * scripts are plain Node, no jsdom/React Testing Library). The component
 * calls these exact functions rather than re-implementing the same boolean
 * logic inline, so a test against these functions is a test against the
 * component's real behavior, not a parallel reimplementation that could
 * silently drift from it.
 */

export interface RuntimePushConfig {
  configured: boolean;
  publicKey: string | null;
}

/**
 * Whether the runtime config response means "push is usable in this
 * browser/deployment". Requires BOTH the server to report itself fully
 * configured AND a real public key value — a server that's only partially
 * configured (e.g. missing the private key/contact email) must never let
 * the client proceed to subscribe, since it would "succeed" locally yet
 * never actually be able to deliver anything.
 */
export function isPushRuntimeConfigured(config: RuntimePushConfig | null | undefined): boolean {
  return !!config?.configured && !!config?.publicKey;
}

/** Whether the browser itself exposes the APIs Web Push needs — independent of server configuration. */
export function isPushCapableBrowser(capabilities: {
  hasNotification: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
}): boolean {
  return capabilities.hasNotification && capabilities.hasServiceWorker && capabilities.hasPushManager;
}

/**
 * Whether the enable flow should proceed to create a PushManager
 * subscription after the permission prompt resolves — ONLY on an explicit
 * "granted". "denied" and "default" both stop here (denied surfaces a
 * toast in the component; "default" means the user dismissed the prompt
 * without choosing either way) — a subscription must never be attempted
 * without a real grant.
 */
export function shouldProceedAfterPermission(permission: NotificationPermission | string): boolean {
  return permission === "granted";
}

/**
 * Whether the browser-side subscribe/register sequence should be reported
 * to the user as "enabled" — ONLY after the server confirms it accepted
 * (persisted) the subscription. A non-2xx response must never flip the UI
 * to enabled, even though the browser itself already created a real
 * PushSubscription object — this is the exact false-positive the
 * production symptom included.
 */
export function shouldEnableAfterSubscribeResponse(res: { ok: boolean }): boolean {
  return res.ok;
}

/**
 * Whether an existing browser-side subscription should be reflected as
 * "enabled" in the UI — requires the server to independently confirm it
 * still recognizes that exact endpoint (see
 * GET /api/notifications/push/subscribe?endpoint=). A subscription only
 * known to the browser (its server row may have been removed after a
 * 404/410 delivery failure) must be shown as disabled/stale, never
 * enabled — the user can then repair it with one more Enable click, which
 * clears the stale local subscription and creates a fresh one.
 */
export function shouldTreatLocalSubscriptionAsEnabled(
  serverVerification: { subscribed: boolean } | null | undefined
): boolean {
  return !!serverVerification?.subscribed;
}
