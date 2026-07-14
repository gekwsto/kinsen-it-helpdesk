import { Building2 } from "lucide-react";

interface ActiveWorkspaceBadgeProps {
  name: string | null;
  className?: string;
}

/**
 * Presentational only — the current workspace name, styled to match the
 * app's existing corporate look (subtle border, soft shadow, rounded,
 * slate/navy text on white). Used standalone when a user has exactly one
 * department (no picker needed) and as WorkspaceSelector's trigger content.
 */
export function ActiveWorkspaceBadge({ name, className }: ActiveWorkspaceBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 shadow-sm ${className ?? ""}`}
    >
      <Building2 className="h-4 w-4 text-blue-600" />
      <span className="flex flex-col leading-none">
        <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Workspace</span>
        <span className="text-sm font-semibold text-slate-800">{name ?? "—"}</span>
      </span>
    </span>
  );
}
