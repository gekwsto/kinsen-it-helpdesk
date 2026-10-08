"use client";

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Non-blocking, amber warning — see lib/activities/activity-conflict.ts for
 * the rule (computeSameDayStartWarnings). This component only renders an
 * already-computed, positive count; it never decides whether to show, and
 * is never rendered for a completed Activity (the caller only passes a
 * count when hasSameDayStartWarning is true, which is itself already false
 * for any completed Activity).
 */
export function SameDayStartWarningBadge({ sameDayStartActiveCount, className }: { sameDayStartActiveCount: number; className?: string }) {
  const tooltipText =
    sameDayStartActiveCount === 1
      ? "Another active activity in this project starts on the same day."
      : `${sameDayStartActiveCount} other active activities start on the same day.`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap bg-amber-100 text-amber-700 cursor-default",
              className
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            Same-day start
          </span>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
