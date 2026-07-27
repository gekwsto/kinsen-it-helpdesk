/**
 * Pure-function tests for lib/navigation-loader.ts — the decision core
 * behind components/layout/navigation-loader.tsx (the global page-
 * transition loader). No DOM/timers/React needed: these are the exact
 * functions the component wires to real setTimeout/window.location.
 *
 * Covers the specific guarantees the loader must hold:
 *  - resolveTargetUrl handles relative/absolute/query-only/hash URLs and
 *    never throws on garbage input.
 *  - isSameRouteNavigation correctly identifies "nothing to wait for"
 *    re-navigations (same pathname+search) without false-positiving on a
 *    genuinely different route.
 *  - createTokenGuard: a stale (superseded) navigation's deferred callback
 *    can never act once a newer navigation has started — the exact
 *    protection against fast successive clicks and old completion
 *    callbacks affecting a newer navigation's loader state.
 *
 *  - shouldTreatClickAsNavigation matches next/link's own modifier-key/
 *    target/download filtering exactly, so ctrl/cmd/shift/alt-clicks,
 *    middle-clicks, target="_blank" links, download links, and
 *    cross-origin links never trigger the loader.
 *
 * Usage: npx tsx scripts/test-navigation-loader.ts
 */
import { resolveTargetUrl, isSameRouteNavigation, createTokenGuard, shouldTreatClickAsNavigation } from "@/lib/navigation-loader";

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

const BASE = "https://app.kinsen.gr/dashboard?tab=tickets";

console.log("Testing resolveTargetUrl...\n");

check("A relative path resolves against the base into pathname+search", resolveTargetUrl("/projects", BASE) === "/projects");
check("A relative path with a query string keeps the query", resolveTargetUrl("/activities?view=list", BASE) === "/activities?view=list");
check("An absolute same-origin URL resolves the same way as a relative one", resolveTargetUrl("https://app.kinsen.gr/projects/gantt", BASE) === "/projects/gantt");
check("A query-only change (same pathname) is captured correctly", resolveTargetUrl("/dashboard?tab=projects", BASE) === "/dashboard?tab=projects");
check("A hash-only fragment is not part of the comparable pathname+search (hash never changes the server-rendered route)", resolveTargetUrl("/dashboard#section", BASE) === "/dashboard");
check("null resolves to null (caller must treat as 'unknown target', not skip)", resolveTargetUrl(null, BASE) === null);
check("undefined resolves to null", resolveTargetUrl(undefined, BASE) === null);
check("A URL instance is accepted the same as a string", resolveTargetUrl(new URL("/settings", BASE), BASE) === "/settings");
check("Garbage input never throws — resolves to null instead", resolveTargetUrl("http://[::not-a-real-host", BASE) === null);
check("The root path resolves correctly", resolveTargetUrl("/", BASE) === "/");

console.log("\nTesting isSameRouteNavigation...\n");

check("Identical pathname+search is a same-route navigation (nothing to wait for)", isSameRouteNavigation("/dashboard?tab=tickets", "/dashboard?tab=tickets") === true);
check("A different pathname is NOT a same-route navigation", isSameRouteNavigation("/projects", "/dashboard?tab=tickets") === false);
check("The same pathname with a DIFFERENT query IS a real navigation (query changes are real transitions)", isSameRouteNavigation("/dashboard?tab=projects", "/dashboard?tab=tickets") === false);
check("A null target (unresolvable) is never treated as same-route — never silently skipped", isSameRouteNavigation(null, "/dashboard?tab=tickets") === false);

console.log("\nTesting createTokenGuard — the fast-successive-navigation / stale-callback protection...\n");

{
  const guard = createTokenGuard();
  const t1 = guard.bump();
  check("First bump returns a token that is immediately current", guard.isCurrent(t1));

  const t2 = guard.bump();
  check("A second, newer bump produces a different token than the first", t2 !== t1);
  check("The newer token is now the current one", guard.isCurrent(t2));
  check("The OLDER token (t1) is no longer current — its deferred callback must no-op", !guard.isCurrent(t1));
}

{
  // Simulates: user clicks A, then clicks B before A's show-delay timer fires.
  const guard = createTokenGuard();
  const tokenForNavA = guard.bump();
  const tokenForNavB = guard.bump(); // B supersedes A before A's timer could ever fire
  check("Nav A's token is stale once Nav B has started (A's deferred 'show' callback must not show the loader for B)", !guard.isCurrent(tokenForNavA));
  check("Nav B's token is the one currently allowed to act", guard.isCurrent(tokenForNavB));
}

{
  // Simulates: navigation resolves (loader stopped, a fresh guard-equivalent
  // reset would happen in the component via a new bump on the NEXT nav) —
  // here we confirm a guard that's had no further bumps still correctly
  // reports its only token as current (no false-negative after a single nav).
  const guard = createTokenGuard();
  const only = guard.bump();
  check("With only one navigation ever started, its token remains current indefinitely (no spurious staleness)", guard.isCurrent(only));
}

{
  // Rapid-fire: 20 successive navigations (like a user mashing the back button) — only the LAST token should ever be current.
  const guard = createTokenGuard();
  const tokens: number[] = [];
  for (let i = 0; i < 20; i++) tokens.push(guard.bump());
  const allButLastAreStale = tokens.slice(0, -1).every((t) => !guard.isCurrent(t));
  const lastIsCurrent = guard.isCurrent(tokens[tokens.length - 1]);
  check("Of 20 rapid-fire navigations, exactly the LAST one's token is current", allButLastAreStale && lastIsCurrent);
}

console.log("\nTesting shouldTreatClickAsNavigation (mirrors next/link's own isModifiedEvent filtering)...\n");

const plainClick = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, targetAttr: null, hasDownloadAttr: false, isSameOrigin: true };

check("A plain left-click on a same-origin, same-tab link is treated as navigation", shouldTreatClickAsNavigation(plainClick));
check("A cmd/meta-click (open in new tab) is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, metaKey: true }));
check("A ctrl-click is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, ctrlKey: true }));
check("A shift-click (open in new window) is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, shiftKey: true }));
check("An alt-click (save link as) is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, altKey: true }));
check("A middle-click (button 1, opens new tab) is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, button: 1 }));
check("A target=\"_blank\" link is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, targetAttr: "_blank" }));
check("A target=\"_self\" link (explicit, same as default) IS still treated as navigation", shouldTreatClickAsNavigation({ ...plainClick, targetAttr: "_self" }));
check("A download link is NOT treated as navigation", !shouldTreatClickAsNavigation({ ...plainClick, hasDownloadAttr: true }));
check("A cross-origin link is NOT treated as navigation (real navigation, but a hard leave-the-app one, not a client transition)", !shouldTreatClickAsNavigation({ ...plainClick, isSameOrigin: false }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
