import { cn } from "@/lib/utils";

/**
 * Single visual for an Activity's status everywhere it's shown (List/Grid,
 * detail, edit form, Gantt, Resource Planning) — label and color are always
 * the CALLER's already-resolved, department-scoped values (see
 * lib/services/activity-status-config.ts), this component only renders
 * them. Never looks up a hardcoded label/color map itself.
 */
export function StatusBadge({ label, color, className }: { label: string; color: string; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap border", className)}
      style={{ backgroundColor: `${color}1a`, borderColor: `${color}40`, color }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

/** Compact dot-only variant for tight layouts (Gantt bars, Resource Planning rows) where a full pill badge doesn't fit. */
export function StatusDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2.5 w-2.5 rounded-full flex-shrink-0", className)} style={{ backgroundColor: color }} />;
}
