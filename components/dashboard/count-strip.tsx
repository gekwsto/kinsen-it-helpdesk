import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface CountStripItem {
  key: string;
  label: string;
  count: number;
  sub: string;
  /** Built from the same conditions as `count`, so the list it opens holds exactly that many items. */
  href: string;
  /** Flags a non-zero count as needing attention (overdue, unassigned). */
  attention?: boolean;
}

/**
 * Dashboard counts as one ruled strip: hairline-divided cells in a single
 * module, not a row of separate icon cards. Each cell is a link to the list
 * it counts; the Kinsen notch marks the cell under the pointer or focus.
 */
export function CountStrip({ items, className }: { items: CountStripItem[]; className?: string }) {
  const cols =
    items.length >= 7 ? "lg:grid-cols-7" : items.length === 4 ? "lg:grid-cols-4" : items.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3";
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border",
        cols,
        className
      )}
    >
      {items.map((item, i) => {
        const flagged = item.attention && item.count > 0;
        // On the 2-column phone grid an odd last cell spans the row instead of leaving a gap.
        const spanLast = items.length % 2 === 1 && i === items.length - 1;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-label={`${item.label}: ${item.count}. ${item.sub}. Open list`}
            className={cn(
              "group relative bg-card px-5 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              spanLast && "col-span-2 lg:col-span-1"
            )}
          >
            <span
              aria-hidden="true"
              className="kinsen-notch absolute left-0 top-1/2 h-3.5 w-2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
            <span className="block text-xs font-medium text-muted-foreground">{item.label}</span>
            <span className="mt-1 flex items-center gap-2">
              <span className="text-2xl font-bold tabular-nums leading-none">{item.count}</span>
              {flagged && <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />}
            </span>
            <span className="mt-1.5 block text-xs text-muted-foreground">{item.sub}</span>
          </Link>
        );
      })}
    </div>
  );
}
