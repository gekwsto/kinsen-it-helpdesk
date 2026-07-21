"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { addDays, addWeeks, addMonths, format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";

export type ResourcePlanningView = "week" | "month";

interface ResourcePlanningToolbarProps {
  view: ResourcePlanningView;
  /** Start of the currently visible range — ISO date, used both to render the label and to compute prev/next. */
  rangeStart: string;
  rangeLabel: string;
}

/**
 * Prev/Next/Today + Week/Month, all URL-driven (`view`, `from`) — matches
 * every other filtered page in this app (TicketFilters, PendingTicketFilters):
 * a click is a `router.push`, the server recomputes rangeStart/rangeEnd and
 * re-fetches. Deliberately NOT internal client state (see the architecture
 * plan's Decision #2) so the visible range is shareable/bookmarkable and the
 * server — not the browser — is what "applies filters."
 */
export function ResourcePlanningToolbar({ view, rangeStart, rangeLabel }: ResourcePlanningToolbarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const push = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const navigate = (direction: -1 | 1) => {
    const start = new Date(rangeStart);
    const next = view === "week" ? addWeeks(start, direction) : addMonths(start, direction);
    push({ from: format(next, "yyyy-MM-dd") });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => navigate(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => push({ from: null })}>
          Today
        </Button>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => navigate(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <span className="text-sm font-medium px-2">{rangeLabel}</span>

      <Select value={view} onValueChange={(v) => push({ view: v === "week" ? null : v, from: null })}>
        <SelectTrigger className="h-8 w-[100px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="week">Week</SelectItem>
          <SelectItem value="month">Month</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
