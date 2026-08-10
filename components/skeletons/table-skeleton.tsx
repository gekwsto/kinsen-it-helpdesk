import { Skeleton } from "@/components/ui/skeleton";

/** Matches TicketTable/ProjectList/ActivityList's `<p>{count} results</p>` + bordered table shell — a fixed row count (not the real total, which isn't known yet) so the boundary never jumps height once real data streams in. */
export function TableSkeleton({ columns = 8, rows = 8 }: { columns?: number; rows?: number }) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-4 w-20" />
      <div className="rounded-lg border overflow-hidden">
        <div className="bg-muted/50 flex items-center gap-4 px-4 py-3 border-b">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton key={i} className="h-3.5 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-3 border-b last:border-b-0">
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
