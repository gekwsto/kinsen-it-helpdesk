/**
 * Small, framework-agnostic idle-time queue runner — the actual App Router
 * prefetch call and any Next.js-specific typing live in the caller
 * (components/navigation/app-route-prefetcher.tsx); this module only knows
 * how to dispatch a list of items one at a time, staggered across idle
 * ticks, cancellable mid-flight. No Next.js/React import here on purpose —
 * it's plain browser scheduling, independently testable.
 */

export interface PrefetchTarget {
  href: string;
  /** "full" fully executes the destination page's real Server Component render (like <Link prefetch> at click); "auto" only warms the static shell/loading boundary for a dynamic route. */
  kind: "auto" | "full";
}

type IdleDeadline = { didTimeout: boolean; timeRemaining: () => number };
type RequestIdleCallback = (callback: (deadline: IdleDeadline) => void, opts?: { timeout: number }) => number;

/** requestIdleCallback isn't implemented in Safari — a short setTimeout is the standard, safe fallback (same one React itself and most scheduling polyfills use). */
function requestIdle(callback: () => void, timeoutMs: number): () => void {
  if (typeof window === "undefined") return () => {};
  const ric = (window as unknown as { requestIdleCallback?: RequestIdleCallback }).requestIdleCallback;
  if (typeof ric === "function") {
    const id = ric(() => callback(), { timeout: timeoutMs });
    return () => (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(callback, Math.min(timeoutMs, 300));
  return () => window.clearTimeout(id);
}

/**
 * Dispatches `targets` in order, ONE at a time — each only once the browser
 * reports itself idle (or after `timeoutMs` as a hard ceiling, so a
 * constantly-busy tab still eventually warms every tier rather than
 * starving forever). This is the actual stagger: item N+1 is never even
 * scheduled until item N's callback has fired, so nothing is ever dispatched
 * in the same tick — the opposite of firing every prefetch simultaneously.
 *
 * Returns a cancel function. Calling it stops any NOT-YET-dispatched item
 * (an already-dispatched `run()` call can't be un-sent, but nothing further
 * fires) — used when a newer, more current pass supersedes an in-flight one
 * (e.g. the active workspace changed mid-warm).
 */
export function runPrefetchQueue(targets: PrefetchTarget[], run: (target: PrefetchTarget) => void, timeoutMs = 2000): () => void {
  let cancelled = false;
  let cancelCurrent: () => void = () => {};

  function step(index: number) {
    if (cancelled || index >= targets.length) return;
    cancelCurrent = requestIdle(() => {
      if (cancelled) return;
      run(targets[index]);
      step(index + 1);
    }, timeoutMs);
  }

  step(0);

  return () => {
    cancelled = true;
    cancelCurrent();
  };
}

/** True on a metered/slow connection (Data Saver, 2G) — Network Information API, Chromium-only, feature-detected. Background prefetching skips itself entirely rather than spend a user's limited/slow data on pages they haven't asked for. */
export function isConnectionConstrained(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return connection.effectiveType === "slow-2g" || connection.effectiveType === "2g";
}
