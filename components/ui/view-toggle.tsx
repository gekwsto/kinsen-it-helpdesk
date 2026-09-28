"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LayoutGrid, List } from "lucide-react";

export type ViewMode = "grid" | "list";

const VIEW_MODES: readonly ViewMode[] = ["grid", "list"];

/**
 * Single canonical resolver for "which view is actually active" — used by
 * this toggle AND independently by each page's own list-rendering component
 * (ProjectList, ActivityList), since those are separate Client Components
 * that each read `?view=` off the URL rather than receiving it as a prop.
 * Any value that isn't a real ViewMode (missing, or an unknown/garbage
 * string) resolves to `defaultView` — so "no explicit choice" and "invalid
 * choice" are never treated differently, and neither can ever render
 * something other than a real, known view. `defaultView` is deliberately
 * REQUIRED (no implicit fallback here) — every call site must say what it
 * wants, since different pages reusing the same components
 * (ProjectList/ActivityList are each single-purpose today, but ViewToggle
 * itself is also used by /my-activities) legitimately want different
 * defaults; see each page's own call site for its actual choice.
 */
export function resolveViewMode(raw: string | null | undefined, defaultView: ViewMode): ViewMode {
  return (VIEW_MODES as string[]).includes(raw ?? "") ? (raw as ViewMode) : defaultView;
}

interface ViewToggleProps {
  /** Query param name to read/write. Defaults to "view". */
  paramName?: string;
  /**
   * View used when the param is absent OR set to something other than a
   * real ViewMode — also the value that gets omitted from the URL entirely
   * when selected (keeps URLs clean), matching ResourcePlanningToolbar's
   * `v === "week" ? null : v` convention. Left at "grid" — this component's
   * own historical default, unchanged for any caller (e.g. /my-activities)
   * that doesn't explicitly opt into something else. /projects and
   * /activities each pass `defaultView="list"` explicitly at their own call
   * sites (see the final report) rather than this shared default changing
   * for everyone.
   */
  defaultView?: ViewMode;
}

/**
 * Grid/List toggle, URL-param driven — matches every other filter/view
 * control in this app (ResourcePlanningToolbar, TicketFilters,
 * SubDepartmentFilter): a click is a router.push, not local/localStorage
 * state, so the chosen view is shareable/bookmarkable.
 */
export function ViewToggle({ paramName = "view", defaultView = "grid" }: ViewToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = resolveViewMode(searchParams.get(paramName), defaultView);

  const setView = (v: ViewMode) => {
    const params = new URLSearchParams(searchParams.toString());
    if (v === defaultView) params.delete(paramName);
    else params.set(paramName, v);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <div className="inline-flex items-center rounded-md border p-0.5" role="group" aria-label="View mode">
      <Button
        type="button"
        size="sm"
        variant={current === "grid" ? "secondary" : "ghost"}
        className="h-7 px-2"
        onClick={() => setView("grid")}
        aria-pressed={current === "grid"}
        aria-label="Grid view"
        title="Grid view"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        size="sm"
        variant={current === "list" ? "secondary" : "ghost"}
        className="h-7 px-2"
        onClick={() => setView("list")}
        aria-pressed={current === "list"}
        aria-label="List view"
        title="List view"
      >
        <List className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
