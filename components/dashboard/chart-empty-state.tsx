import type { LucideIcon } from "lucide-react";
import { BarChart3 } from "lucide-react";

interface ChartEmptyStateProps {
  label: string;
  icon?: LucideIcon;
  /** Matches the chart area's own fixed height (h-48 in every chart card) so swapping this in never shifts the card's overall height. */
  className?: string;
}

/** Shared empty state for every dashboard chart card — same icon-in-circle + muted text shape already used for NoWorkspaceState (components/workspace/workspace-gate.tsx), instead of each chart inventing its own plain centered string. */
export function ChartEmptyState({ label, icon: Icon = BarChart3, className = "h-48" }: ChartEmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 ${className}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
