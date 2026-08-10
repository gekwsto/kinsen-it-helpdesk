import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { FilterBarSkeleton } from "@/components/skeletons/filter-bar-skeleton";
import { CardGridSkeleton } from "@/components/skeletons/card-list-skeleton";

export default function ActivitiesLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton withSecondaryAction />
      <FilterBarSkeleton quickFilterCount={4} />
      <CardGridSkeleton />
    </div>
  );
}
