import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusMark, PriorityMark } from "@/components/shared/marks";
import { ColorBadge } from "@/components/tickets/ticket-badge";

export interface BreakdownRow {
  label: string;
  count: number;
  color: string;
  /** Which mark to draw beside the label; "swatch" for categories/owners. */
  mark?: "status" | "priority" | "swatch" | "none";
  closed?: boolean;
  rank?: number;
}

interface BreakdownListProps {
  title: string;
  rows: BreakdownRow[];
  emptyLabel: string;
  /** Shown beside the title, e.g. "14 open". */
  totalLabel?: string;
}

/**
 * Dashboard breakdowns as ruled ledger rows instead of pies and colour-only
 * legends: mark + neutral label, a tabular count, and one neutral-ink bar
 * scaled to the largest row. Colour stays in the mark; the bar never
 * carries meaning by hue.
 */
export function BreakdownList({ title, rows, emptyLabel, totalLabel }: BreakdownListProps) {
  const max = Math.max(0, ...rows.map((r) => r.count));
  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row flex-wrap items-baseline justify-between gap-x-4 gap-y-1 space-y-0 pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {totalLabel && <span className="text-sm tabular-nums text-muted-foreground">{totalLabel}</span>}
      </CardHeader>
      <CardContent className="flex-1 p-0">
        {max === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y border-t">
            {rows.map((row) => (
              <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_2rem_2.5rem] items-center gap-3 px-5 py-2 sm:grid-cols-[minmax(0,1fr)_2.5rem_minmax(3rem,40%)]">
                <span className="min-w-0 truncate">
                  {row.mark === "status" ? (
                    <StatusMark label={row.label} color={row.color} closed={row.closed} />
                  ) : row.mark === "priority" ? (
                    <PriorityMark label={row.label} rank={row.rank ?? 1} color={row.color} />
                  ) : row.mark === "none" ? (
                    <span className="text-xs font-medium">{row.label}</span>
                  ) : (
                    <ColorBadge name={row.label} color={row.color} />
                  )}
                </span>
                <span className="text-right text-sm font-semibold tabular-nums">{row.count}</span>
                <span className="h-1.5 rounded-sm bg-muted" aria-hidden="true">
                  <span className="block h-full rounded-sm bg-foreground/60" style={{ width: max ? `${(row.count / max) * 100}%` : 0 }} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
