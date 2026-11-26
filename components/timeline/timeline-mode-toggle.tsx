"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  TIMELINE_MODES,
  TIMELINE_MODE_LABEL,
  TIMELINE_MODE_PARAM,
  DEFAULT_TIMELINE_MODE,
  type TimelineMode,
} from "@/lib/timeline-mode";

interface TimelineModeToggleProps {
  mode: TimelineMode;
  className?: string;
}

/**
 * Actual / Expected timeline switch, shared by Project Gantt and Resource
 * Planning. URL-driven (`?timeline=expected`; the default, Actual, is the
 * absence of the param) so the server re-resolves dates AND its date-range
 * filtering for the selected mode. Every other search param (filters,
 * department, view, from/to) is carried over untouched.
 */
export function TimelineModeToggle({ mode, className }: TimelineModeToggleProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const select = (next: TimelineMode) => {
    if (next === mode) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_TIMELINE_MODE) params.delete(TIMELINE_MODE_PARAM);
    else params.set(TIMELINE_MODE_PARAM, next);
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  return (
    <div
      role="group"
      aria-label="Timeline dates"
      data-testid="timeline-mode-toggle"
      data-mode={mode}
      className={cn("flex items-center gap-1 border rounded-lg p-1 bg-background", pending && "opacity-70", className)}
    >
      {TIMELINE_MODES.map((m) => (
        <Button
          key={m}
          type="button"
          variant={mode === m ? "default" : "ghost"}
          size="sm"
          className="h-7 px-3 text-xs"
          aria-pressed={mode === m}
          title={m === "actual" ? "Show Actual Start / Finish dates" : "Show Expected Start / Finish dates (read-only)"}
          onClick={() => select(m)}
        >
          {TIMELINE_MODE_LABEL[m]}
        </Button>
      ))}
    </div>
  );
}
