import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Single visual for "no configured progress percentage" everywhere a
 * status-derived progress value is shown (Activity List/Grid/cards, Project
 * detail, Gantt). `progress: null` means lib/activities/activity-progress.ts
 * found no enabled ActivityProgressConfig row for this department+status —
 * this badge is what MUST be rendered in that case, never a fabricated
 * "0%" that would look like a real business value.
 */
export function ProgressConfigGapBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap bg-amber-100 text-amber-700",
        className
      )}
      title="No progress percentage is configured for this status in this department. Ask an admin to configure it under Activity Progress."
    >
      <AlertCircle className="h-3 w-3" />
      Configuration required
    </span>
  );
}

/** Compact inline variant for tight table/card layouts where the full badge doesn't fit. */
export function ProgressConfigGapInline({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs font-medium text-amber-700", className)}
      title="No progress percentage is configured for this status in this department. Ask an admin to configure it under Activity Progress."
    >
      <AlertCircle className="h-3 w-3" />
      Config required
    </span>
  );
}
