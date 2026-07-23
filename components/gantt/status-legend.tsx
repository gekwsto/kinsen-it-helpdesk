import { cn } from "@/lib/utils";
import { STATUS_BAR, STATUS_LABEL } from "@/components/gantt/status-colors";

interface StatusLegendProps {
  /** Which keys to show, in order. Defaults to every key in STATUS_LABEL (Project Gantt's full set, including PLANNING). */
  statusKeys?: string[];
  className?: string;
}

/** Color swatch + label per status — identical markup Project Gantt already used inline, now shared with Resource Planning. */
export function StatusLegend({ statusKeys, className }: StatusLegendProps) {
  const keys = statusKeys ?? Object.keys(STATUS_LABEL);
  return (
    <div className={cn("flex flex-wrap gap-3 text-xs text-muted-foreground", className)}>
      {keys.map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className={cn("inline-block h-2 w-4 rounded-sm", STATUS_BAR[k])} />
          {STATUS_LABEL[k] ?? k}
        </span>
      ))}
    </div>
  );
}
