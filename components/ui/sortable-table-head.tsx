"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { TableHead } from "@/components/ui/table";
import { ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SortableTableHeadProps {
  /** Must be one of the server page's own whitelisted sort keys (see lib/list-sort.ts) — this component never invents a key, it only ever reads/writes the URL. */
  sortKey: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * A clickable List-view column header: ascending on first click, descending
 * on a second click of the SAME column, and back to ascending on a third —
 * toggling only ever between the two (never a tri-state "unsorted" once a
 * column has been clicked). Reused identically by Projects and Activities'
 * List views — only `sortKey` differs per column/page.
 *
 * URL-param driven, same convention as every other filter control in this
 * app (TicketFilters, ViewToggle): reading/writing `?sortBy=&sortOrder=`
 * directly, never local component state, so the current sort survives
 * pagination, a page refresh, and router.refresh() from the realtime
 * live-refresh components untouched. Changing the sort column always drops
 * `page` back to 1 (a different order is a different result set to page
 * through); every OTHER param (search, filters, view) is preserved
 * verbatim via the same `new URLSearchParams(searchParams.toString())`
 * pattern ticket-filters.tsx's own `push()` already uses.
 */
export function SortableTableHead({ sortKey, children, className }: SortableTableHeadProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeKey = searchParams.get("sortBy");
  const isActive = activeKey === sortKey;
  const currentOrder = isActive && searchParams.get("sortOrder") === "desc" ? "desc" : "asc";
  const nextOrder = isActive && currentOrder === "asc" ? "desc" : "asc";

  const handleClick = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", sortKey);
    params.set("sortOrder", nextOrder);
    params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <TableHead className={className} aria-sort={isActive ? (currentOrder === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          "inline-flex items-center gap-1 -mx-1 px-1 py-0.5 rounded hover:bg-muted/60 hover:text-foreground transition-colors",
          isActive && "text-foreground font-medium"
        )}
      >
        {children}
        {isActive &&
          (currentOrder === "asc" ? (
            <ArrowUp className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          ))}
      </button>
    </TableHead>
  );
}
