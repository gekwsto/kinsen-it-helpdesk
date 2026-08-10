import { Skeleton } from "@/components/ui/skeleton";

/** Matches the bordered-card filter bar shape shared by TicketFilters/ProjectFilters/ActivityFilters: a search+sort row, then a row of quick-filter selects. */
export function FilterBarSkeleton({ quickFilterCount = 4 }: { quickFilterCount?: number }) {
  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-[150px]" />
        <Skeleton className="h-9 w-9 flex-shrink-0" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {Array.from({ length: quickFilterCount }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-32" />
        ))}
      </div>
    </div>
  );
}
