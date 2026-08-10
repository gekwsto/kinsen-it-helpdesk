"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import type { Role } from "@prisma/client";
import { canManageProjects, isAdmin } from "@/lib/nav-access";
import { useActiveWorkspace } from "@/components/workspace/active-workspace-provider";
import type { NavVisibilityFlags } from "@/lib/services/department-scope-service";
import { runPrefetchQueue, isConnectionConstrained, type PrefetchTarget } from "@/lib/route-prefetch-scheduler";

const DEV = process.env.NODE_ENV !== "production";

interface AppRoutePrefetcherProps {
  userRole: Role;
  canCreateTicket: boolean;
  navFlags: NavVisibilityFlags;
}

/**
 * Routes whose Server Component data is scoped to the active workspace
 * (departmentId) — must be re-warmed every time the workspace changes, or a
 * page could otherwise show a Finance-scoped prefetch after switching to
 * another department. Gating mirrors Sidebar's OWN visibility logic exactly
 * (canManageProjects/isAdmin from lib/nav-access.ts, navFlags computed once
 * in app/(main)/layout.tsx and passed down here unchanged) — never a second,
 * independently-hardcoded authorization system.
 *
 * Tier 1 (kind: "full") — the two highest-traffic landing pages get a REAL
 * prefetch: Next.js actually executes the destination page's Server
 * Component render (same code a real visit runs, see next/navigation's
 * PrefetchKind.FULL, the documented mechanism behind `<Link prefetch>`),
 * warming Prisma's connection pool / query plan cache for that exact query
 * shape moments before the user is likely to click. This client's
 * `staleTimes.dynamic` is the framework default (0 — unconfigured in
 * next.config.ts), so the actual navigation still always re-fetches fresh
 * data; a full prefetch never risks serving stale post-mutation or
 * post-workspace-switch content, it only warms the path.
 *
 * Tier 2/3 (kind: "auto", the default) — cheaper: only the static shell up
 * to each route's loading.tsx boundary is prefetched (JS chunks + the
 * instant loading skeleton), never a real DB hit. Bounding the "full" tier
 * to just 2 routes is what keeps this architecture safe as ticket/project/
 * activity volume grows — it can never become N heavy queries fired at once
 * regardless of how many sidebar destinations exist.
 */
function buildWorkspaceScopedTargets(role: Role, navFlags: NavVisibilityFlags): PrefetchTarget[] {
  const targets: PrefetchTarget[] = [{ href: "/dashboard", kind: "full" }];
  if (canManageProjects(role)) targets.push({ href: "/tickets", kind: "full" });
  if (canManageProjects(role)) {
    targets.push({ href: "/projects", kind: "auto" });
    targets.push({ href: "/activities", kind: "auto" });
  }
  if (navFlags.canViewPendingTickets) targets.push({ href: "/tickets/pending", kind: "auto" });
  if (isAdmin(role)) targets.push({ href: "/tickets/closed", kind: "auto" });
  return targets;
}

/**
 * Routes whose data is scoped to the signed-in user only (own tickets/
 * projects/activities/goals) — never department-dependent (confirmed
 * against each page's own query: buildAssignedToMeWhere/buildCreatedByMeWhere
 * take no department unless the URL explicitly asks, /my-projects and
 * /my-activities filter by ownerId/assignedUsers only, /goals by
 * ownerUserId only). Warmed once and never re-triggered by a workspace
 * switch — nothing about their result set depends on it.
 */
function buildPersonalScopedTargets(role: Role): PrefetchTarget[] {
  const targets: PrefetchTarget[] = [
    { href: "/tickets/assigned-to-me", kind: "auto" },
    { href: "/tickets/created-by-me", kind: "auto" },
  ];
  if (canManageProjects(role)) {
    targets.push({ href: "/my-projects", kind: "auto" });
    targets.push({ href: "/my-activities", kind: "auto" });
    targets.push({ href: "/goals", kind: "auto" });
  }
  return targets;
}

/**
 * [PREFETCH] start logging — dev-only (process.env.NODE_ENV is inlined at
 * build time, so this branch is fully stripped from the production bundle,
 * never spamming real logs). Deliberately logs only "start", not a
 * "complete" pair: router.prefetch() returns void with no completion
 * signal in the public API, and this app registers a Service Worker (push
 * notifications, see components/notifications/notification-dropdown.tsx)
 * that intercepts fetches — confirmed empirically that Service Worker
 * interception suppresses the Resource Timing entries a
 * PerformanceObserver would otherwise use to infer completion, so a
 * "complete" log would either silently never fire or lie. Verify actual
 * completion/timing via the Network tab (filter: Fetch/XHR, header
 * `Next-Router-Prefetch: 1`) instead, which reflects the real request.
 */
function logPrefetchStart(href: string, kind: PrefetchTarget["kind"]) {
  if (!DEV) return;
  // eslint-disable-next-line no-console
  console.debug(`[PREFETCH] start ${href} (${kind})`);
}

/**
 * Mounted ONCE inside the authenticated app shell (app/(main)/layout.tsx).
 * Warms the routes a user is statistically likely to click next, in the
 * background, while they're still looking at the current page — never a
 * bulk data load. See the module-level doc comments above for the exact
 * tiering/permission/workspace-reactivity rules.
 */
export function AppRoutePrefetcher({ userRole, canCreateTicket, navFlags }: AppRoutePrefetcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { departmentId, isAllSelected, switching } = useActiveWorkspace();
  const cancelRef = useRef<() => void>(() => {});
  const hasWarmedPersonalRef = useRef(false);

  const runTarget = useCallback(
    ({ href, kind }: PrefetchTarget) => {
      if (href === pathname) return; // the current page needs no prefetch — it's already loaded
      logPrefetchStart(href, kind);
      try {
        if (kind === "full") {
          // PrefetchKind.FULL isn't re-exported from the public `next/navigation`
          // entrypoint (it lives in an internal router-reducer module) — the
          // literal string is this router version's actual runtime value
          // (a plain string enum) and is exactly what <Link prefetch={true}>
          // passes under the hood, so this relies on stable public behavior,
          // not an internal import path.
          router.prefetch(href, { kind: "full" } as unknown as Parameters<typeof router.prefetch>[1]);
        } else {
          router.prefetch(href);
        }
      } catch {
        // Prefetching is a pure optimization — any failure here (odd router
        // state, a navigation already in flight, etc.) must never surface to
        // the user or block real navigation, which still works normally.
      }
    },
    [pathname, router]
  );

  // Workspace-scoped tiers — re-warmed on mount AND every time the active
  // workspace actually changes. `switching` gates this: ActiveWorkspaceProvider
  // updates departmentId/isAllSelected OPTIMISTICALLY before the workspace
  // switch's own fetch (which sets the new cookie) has even resolved, so
  // reacting to that optimistic value would prefetch against the OLD cookie
  // still sitting in the browser. Waiting for `switching` to settle back to
  // false guarantees the cookie write has completed AND that
  // ActiveWorkspaceProvider's own router.refresh() (see setActiveDepartment)
  // has already cleared Next's client-side prefetch cache for us — confirmed
  // against next/dist/client/components/router-reducer/reducers/refresh-reducer.js,
  // which replaces the whole prefetch cache with a fresh empty Map on every
  // refresh(). No separate invalidation logic is needed here; this effect
  // only has to re-warm, never to clear anything itself.
  useEffect(() => {
    if (switching) return;
    if (isConnectionConstrained()) return;
    cancelRef.current();
    cancelRef.current = runPrefetchQueue(buildWorkspaceScopedTargets(userRole, navFlags), runTarget);
    return () => cancelRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switching, departmentId, isAllSelected, userRole, navFlags, runTarget]);

  // User-scoped tiers — never department-dependent, warmed exactly once.
  useEffect(() => {
    if (hasWarmedPersonalRef.current) return;
    if (isConnectionConstrained()) return;
    hasWarmedPersonalRef.current = true;
    const cancel = runPrefetchQueue(buildPersonalScopedTargets(userRole), runTarget);
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userRole, runTarget]);

  // Tier 4 — cheap, obviously-useful extras, warmed last and only if the
  // user can actually reach them; deliberately NOT the admin subtree (a
  // large surface outside this task's named routes — visited on demand,
  // never preemptively background-loaded for anyone).
  useEffect(() => {
    if (isConnectionConstrained()) return;
    const targets: PrefetchTarget[] = [{ href: "/settings", kind: "auto" }];
    if (canCreateTicket) targets.push({ href: "/tickets/new", kind: "auto" });
    const cancel = runPrefetchQueue(targets, runTarget, 4000);
    return cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreateTicket, runTarget]);

  return null;
}
