/**
 * Centralized active-route resolver for the sidebar's expandable sections
 * (components/layout/sidebar.tsx) — pure, no React/DOM dependency, so it's
 * directly unit-testable (see scripts/test-sidebar-active-route.ts) without
 * rendering the component.
 *
 * The bug this exists to fix: a naive per-item `pathname.startsWith(href + "/")`
 * check is not sibling-aware. Given siblings "/projects" (All Projects) and
 * "/projects/new" (New Project), pathname "/projects/new" legitimately
 * starts with "/projects/" — so both lit up as active simultaneously. Every
 * sibling candidate must be considered TOGETHER, not independently.
 */

/**
 * Resolves exactly ONE "most specific" href among a set of SIBLING
 * candidates for the current pathname — "most specific route wins," the
 * same principle Next.js itself uses to prefer a static route over a
 * less-specific dynamic one. Returns null if no candidate matches at all.
 *
 * This also preserves "a detail page maps to the parent list item" for
 * free: /tickets/<id> matches only "/tickets" (no sibling child href like
 * /tickets/new or /tickets/pending is a prefix of it), so "All Tickets"
 * still lights up correctly on a ticket detail page. Meanwhile
 * /projects/new matches BOTH "/projects" (len 9, via the "/projects/"
 * prefix) and "/projects/new" (len 13, exact) — the longer one wins, so
 * only "New Project" lights up.
 *
 * Exact match and prefix match are treated identically for scoring
 * (compared by href length) — an exact match's href length always equals
 * the matched pathname's own most-specific-candidate length in practice
 * here, so there's no real ambiguity to break a tie on; if two DIFFERENT
 * candidate hrefs of the exact same length both matched (not possible with
 * this app's actual routes, which never have two sibling hrefs of equal
 * length both matching the same pathname), the first one encountered wins
 * deterministically (Array.prototype semantics), never a random choice.
 */
export function resolveActiveHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = pathname === href || pathname.startsWith(href + "/");
    if (!matches) continue;
    if (!best || href.length > best.length) best = href;
  }
  return best;
}
