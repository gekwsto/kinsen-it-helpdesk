import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { CardGridSkeleton } from "@/components/skeletons/card-list-skeleton";

export default function MyActivitiesLoading() {
  return (
    <div className="space-y-6">
      <PageHeaderSkeleton withSecondaryAction />
      <CardGridSkeleton />
    </div>
  );
}
