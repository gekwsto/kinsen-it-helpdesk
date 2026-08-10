import { Skeleton } from "@/components/ui/skeleton";
import { FilterBarSkeleton } from "@/components/skeletons/filter-bar-skeleton";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";

export default function ClosedTicketsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <FilterBarSkeleton quickFilterCount={5} />
      <TableSkeleton columns={11} />
    </div>
  );
}
