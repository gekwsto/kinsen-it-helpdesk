import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { FilterBarSkeleton } from "@/components/skeletons/filter-bar-skeleton";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";

export default function AllTicketsLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <FilterBarSkeleton quickFilterCount={5} />
      <TableSkeleton columns={11} />
    </div>
  );
}
