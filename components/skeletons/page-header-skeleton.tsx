import { Skeleton } from "@/components/ui/skeleton";

/** Matches every list page's header row: `<h1>` + subtitle on the left, one or two action buttons on the right. Used by loading.tsx boundaries only — never rendered once real data arrives. */
export function PageHeaderSkeleton({ withSecondaryAction = false }: { withSecondaryAction?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="flex items-center gap-2">
        {withSecondaryAction && <Skeleton className="h-9 w-24" />}
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}
