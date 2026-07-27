import { cn } from "@/lib/utils";
import { STATUS_BAR, STATUS_LABEL } from "@/components/gantt/status-colors";

interface StatusLegendProps {
  /** Which keys to show, in order. Defaults to every key in STATUS_LABEL (Project Gantt's full set, including PLANNING). Ignored when `entries` is provided. */
  statusKeys?: string[];
  /**
   * Real, department-resolved {key,label,color} entries (see
   * lib/services/activity-status-config.ts) — used instead of the legacy
   * static maps whenever a single department's config is available (e.g.
   * Resource Planning, or Project Gantt scoped to one department). Falls
   * back to the legacy maps only when no single department applies (an
   * "All Workspaces" Gantt view spanning multiple departments, or Project
   * statuses, which aren't part of this department-scoping system).
   */
  entries?: { key: string; label: string; color: string }[];
  className?: string;
}

/** Color swatch + label per status — identical markup Project Gantt already used inline, now shared with Resource Planning. */
export function StatusLegend({ statusKeys, entries, className }: StatusLegendProps) {
  if (entries) {
    return (
      <div className={cn("flex flex-wrap gap-3 text-xs text-muted-foreground", className)}>
        {entries.map((e) => (
          <span key={e.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: e.color }} />
            {e.label}
          </span>
        ))}
      </div>
    );
  }
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
