"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { resolveTargetUrl, isSameRouteNavigation, createTokenGuard, shouldTreatClickAsNavigation } from "@/lib/navigation-loader";

// Only actually show the overlay if a navigation is still pending after this
// long — most in-app transitions resolve faster than this, so the loader
// never appears for them at all (not "shown then hidden fast", genuinely
// never rendered). This is the ONLY delay in this component; there is no
// minimum-visible-duration timer anywhere — the overlay hides the instant
// the target route has actually committed, however soon that is.
const SHOW_DELAY_MS = 150;

// Pure failure recovery, not a UX delay: if a navigation never resolves at
// all (failed request, dropped connection, an edge case Next's router
// doesn't recover from on its own), this guarantees the overlay can never
// stay stuck forever. 15s is far longer than any real navigation should
// ever take — this only fires when something has already gone wrong.
const SAFETY_TIMEOUT_MS = 15000;

/**
 * Global page-transition loader (App Router has no router.events, unlike
 * the old Pages Router). "Navigation start" has no single hook in this
 * Next.js version, so this listens at every point a navigation can
 * actually originate from, verified individually against the real
 * behavior (not assumed):
 *
 * 1. <Link> clicks — a capture-phase `click` listener on `document`,
 *    filtered exactly like next/link's own isModifiedEvent check
 *    (node_modules/next/dist/client/link.js: same-tab, no modifier keys,
 *    no download attribute) via shouldTreatClickAsNavigation
 *    (lib/navigation-loader.ts). This turned out to be the ONLY reliable
 *    hook for Link clicks: <Link> in this Next.js version does NOT
 *    dispatch through the public router instance next/navigation's
 *    useRouter() returns (confirmed empirically — patching that instance's
 *    .push never fired for a real Link click, only for direct
 *    application-code router.push() calls), so there is no supported
 *    JS-level hook that fires for a Link click specifically. A capture-
 *    phase click listener needs no such hook — it's the earliest possible
 *    DOM signal, before any handler (Next's or React's) runs.
 * 2. Programmatic router.push()/router.replace() calls (every filter/tab/
 *    view-toggle in this app that calls useRouter().push() directly) — a
 *    patch on the .push/.replace methods of the router instance
 *    next/navigation's useRouter() returns (a stable singleton — the
 *    documented public AppRouterInstance type). Verified this one DOES
 *    fire correctly for direct application-code calls.
 * 3. Browser back/forward — a native `popstate` listener. AppRouterInstance
 *    .back()/.forward() just call window.history.back()/forward(), so
 *    popstate is the only, and a genuinely synchronous, "start" signal.
 *
 * Deliberately NOT anchored on window.history.pushState/replaceState,
 * despite that being an initially-plausible approach: Next's App Router
 * only calls pushState/replaceState from a useInsertionEffect reacting to
 * router state that has ALREADY been updated to the new route (see
 * HistoryUpdater in node_modules/next/dist/client/components/app-router.js)
 * — i.e. pushState fires once the transition has essentially already
 * resolved, not when it starts. Verified directly: an artificially delayed
 * navigation never made a pushState-anchored version of this loader appear
 * at all, because by the time pushState fired, there was nothing left to
 * wait for.
 *
 * "Navigation complete" is anchored on usePathname()/useSearchParams(): by
 * the time a client transition commits, these hooks reflect the NEW route
 * and the new route's content is already what's rendered (React's
 * transition semantics keep the old UI visible until the new one is ready,
 * then swaps both together) — so reacting to these values changing is
 * always a correct "the target is actually ready" signal, never an early
 * guess. This part needed no change through any of the above — a "did the
 * route actually change" signal is correct regardless of what triggered it.
 */
function NavigationLoaderInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [visible, setVisible] = useState(false);

  const tokenGuardRef = useRef(createTokenGuard());
  const pendingRef = useRef(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentUrlRef = useRef("");

  function clearTimers() {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (safetyTimerRef.current) {
      clearTimeout(safetyTimerRef.current);
      safetyTimerRef.current = null;
    }
  }

  function stopLoading() {
    pendingRef.current = false;
    clearTimers();
    setVisible(false);
  }

  // `myToken` guards the deferred setVisible(true) below: if a NEWER
  // navigation starts (or the pending one already resolved) before the
  // show-delay elapses, this stale callback must not flip the loader back
  // on — a stale start callback can never show/keep a loader that belongs
  // to an earlier, already-superseded navigation.
  function startLoading(targetUrl: string | null) {
    // Re-navigating to the exact same URL (e.g. clicking the already-active
    // sidebar link) has nothing to actually wait for — usePathname()/
    // useSearchParams() will never change value, so nothing would ever
    // clear a loader started here. Skipping it entirely is the correct fix,
    // not a compensating timeout.
    if (isSameRouteNavigation(targetUrl, currentUrlRef.current)) return;

    const myToken = tokenGuardRef.current.bump();
    pendingRef.current = true;
    clearTimers();

    showTimerRef.current = setTimeout(() => {
      if (pendingRef.current && tokenGuardRef.current.isCurrent(myToken)) {
        setVisible(true);
      }
    }, SHOW_DELAY_MS);

    safetyTimerRef.current = setTimeout(() => {
      if (tokenGuardRef.current.isCurrent(myToken)) stopLoading();
    }, SAFETY_TIMEOUT_MS);
  }

  // The route actually changed (pathname or query) — whatever navigation
  // was pending has resolved, successfully or via a redirect (auth/
  // permission redirects land here too, just with a different final
  // pathname than what was clicked). Always correct to stop here: this
  // effect only ever fires with the CURRENT, truly-committed route.
  useEffect(() => {
    currentUrlRef.current = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : "");
    stopLoading();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams]);

  useEffect(() => {
    const originalPush = router.push.bind(router);
    const originalReplace = router.replace.bind(router);

    router.push = ((href: string, options?: Parameters<typeof router.push>[1]) => {
      startLoading(resolveTargetUrl(href, window.location.href));
      return originalPush(href, options);
    }) as typeof router.push;
    router.replace = ((href: string, options?: Parameters<typeof router.replace>[1]) => {
      startLoading(resolveTargetUrl(href, window.location.href));
      return originalReplace(href, options);
    }) as typeof router.replace;

    // Capture phase (before Next's own Link handler or anything else can
    // stop propagation) — the earliest possible signal for a <Link> click.
    function onClickCapture(e: MouseEvent) {
      if (e.defaultPrevented) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const isSameOrigin = anchor.origin === window.location.origin;
      const shouldTreat = shouldTreatClickAsNavigation({
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        targetAttr: anchor.getAttribute("target"),
        hasDownloadAttr: anchor.hasAttribute("download"),
        isSameOrigin,
      });
      if (!shouldTreat) return;
      startLoading(resolveTargetUrl(anchor.href, window.location.href));
    }
    document.addEventListener("click", onClickCapture, true);

    // Back/forward goes through neither a Link click nor push/replace —
    // see the module doc comment above.
    function onPopState() {
      startLoading(window.location.pathname + window.location.search);
    }
    window.addEventListener("popstate", onPopState);

    return () => {
      router.push = originalPush;
      router.replace = originalReplace;
      document.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("popstate", onPopState);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      className={cn(
        "fixed inset-0 z-[100] flex items-center justify-center",
        "bg-background/80 backdrop-blur-sm",
        "transition-opacity duration-150 motion-reduce:transition-none",
        visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      )}
    >
      <div className="flex flex-col items-center gap-3">
        <Image
          src="/kinsen_vertical.webp"
          alt=""
          width={512}
          height={512}
          className="h-16 w-16 object-contain animate-pulse motion-reduce:animate-none"
        />
        {visible && <span className="sr-only">Loading page…</span>}
      </div>
    </div>
  );
}

/** useSearchParams() requires a Suspense boundary in the App Router — scoped tightly around just this component, not the rest of the tree. */
export function NavigationLoader() {
  return (
    <Suspense fallback={null}>
      <NavigationLoaderInner />
    </Suspense>
  );
}
