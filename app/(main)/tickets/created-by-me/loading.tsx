import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { FilterBarSkeleton } from "@/components/skeletons/filter-bar-skeleton";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";

export default function CreatedByMeLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton />
      <FilterBarSkeleton quickFilterCount={4} />
      <TableSkeleton columns={10} />
    </div>
  );
}
