"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LayoutGrid, List } from "lucide-react";

export type ViewMode = "grid" | "list";

interface ViewToggleProps {
  /** Query param name to read/write. Defaults to "view". */
  paramName?: string;
  /** View shown when the param is absent — also the value that gets omitted from the URL entirely (keeps URLs clean), matching ResourcePlanningToolbar's `v === "week" ? null : v` convention. */
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
  const current = (searchParams.get(paramName) as ViewMode | null) ?? defaultView;

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
