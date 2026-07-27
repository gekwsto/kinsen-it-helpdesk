import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Single visual for "overdue" everywhere it's shown (Projects/Activities
 * list+cards, Project Gantt, Projects Dashboard) — corporate-style small
 * badge, not a redesign. Callers always pass an already-computed boolean
 * (see lib/overdue.ts) — this component renders, it never decides.
 */
export function OverdueBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap bg-red-100 text-red-700",
        className
      )}
    >
      <AlertTriangle className="h-3 w-3" />
      Overdue
    </span>
  );
}
