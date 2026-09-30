import { Building2 } from "lucide-react";

interface ActiveWorkspaceBadgeProps {
  name: string | null;
  className?: string;
}

/**
 * Presentational only — the current workspace name on one line, sized to
 * the top bar's 36px controls. Used standalone when a user has exactly one
 * department (no picker needed) and as WorkspaceSelector's trigger content.
 */
export function ActiveWorkspaceBadge({ name, className }: ActiveWorkspaceBadgeProps) {
  return (
    <span
      className={`inline-flex h-9 items-center gap-2 rounded border border-input bg-card px-3 text-sm ${className ?? ""}`}
    >
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span className="hidden text-muted-foreground sm:inline">Workspace</span>
      <span className="truncate font-semibold text-foreground">{name ?? "—"}</span>
    </span>
  );
}
