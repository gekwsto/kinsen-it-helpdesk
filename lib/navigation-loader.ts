/**
 * Pure decision logic for components/layout/navigation-loader.tsx, pulled
 * out so it's independently testable (no DOM/timers/React needed) — the
 * component wires these to real setTimeout/window.location, this module
 * only ever makes decisions from plain inputs.
 */

/** Resolves a pushState/replaceState `url` argument (absolute, relative, or omitted) against a base href into a comparable "pathname + search" string. Never throws — an unparseable url resolves to null, treated as "unknown target" by the caller (never skipped, never silently ignored). */
export function resolveTargetUrl(url: string | URL | null | undefined, baseHref: string): string | null {
  if (url == null) return null;
  try {
    const resolved = new URL(url.toString(), baseHref);
    return resolved.pathname + resolved.search;
  } catch {
    return null;
  }
}

/**
 * True only when a navigation's resolved target is the EXACT same route
 * (pathname + search) the app is already on — re-clicking the current
 * page/active sidebar link. There is nothing for such a navigation to
 * transition INTO: usePathname()/useSearchParams() will never change
 * value, so a loader started for it could never be cleared by the normal
 * "route changed" signal. Skipping it at the source is the fix, not a
 * compensating timeout.
 */
export function isSameRouteNavigation(targetUrl: string | null, currentUrl: string): boolean {
  return targetUrl !== null && targetUrl === currentUrl;
}

/**
 * Whether a click on an anchor element should be treated as an in-app,
 * same-tab navigation "start" signal. Mirrors next/link's own
 * isModifiedEvent check (node_modules/next/dist/client/link.js) exactly —
 * a modifier-key click, middle-click, an explicit target!=_self, or a
 * download link all open/save rather than navigate this tab, and must
 * never trigger the loader.
 */
export function shouldTreatClickAsNavigation(info: {
  button: number; // MouseEvent.button — 1 is the middle mouse button
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  targetAttr: string | null; // the anchor's target="" attribute, if any
  hasDownloadAttr: boolean;
  isSameOrigin: boolean;
}): boolean {
  if (!info.isSameOrigin) return false;
  if (info.hasDownloadAttr) return false;
  if (info.targetAttr && info.targetAttr !== "_self") return false;
  if (info.metaKey || info.ctrlKey || info.shiftKey || info.altKey) return false;
  if (info.button === 1) return false; // middle-click opens a new tab
  return true;
}

/**
 * Minimal token guard: each navigation start gets a new, strictly
 * increasing token. Any deferred callback (the show-delay timer, the
 * safety timeout) captures its own token at schedule time and must check
 * `isCurrent` before acting — a callback whose token is no longer the
 * latest belongs to a navigation that has since been superseded (a newer
 * navigation started) or already resolved, and must be a no-op. This is
 * the guarantee that an old navigation's completion/show callback can
 * never affect a newer navigation's loader state.
 */
export function createTokenGuard() {
  let current = 0;
  return {
    bump(): number {
      current += 1;
      return current;
    },
    isCurrent(token: number): boolean {
      return token === current;
    },
    get value() {
      return current;
    },
  };
}
