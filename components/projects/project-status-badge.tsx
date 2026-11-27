import { cn } from "@/lib/utils";

/** The configured Project Status as displayed — see lib/services/project-status-service.ts. */
export interface ProjectStatusDisplay {
  id: string;
  label: string;
  color: string;
  isActive?: boolean;
}

/**
 * THE Project status pill: the configured label with a dot in the configured
 * color (same dot convention as QuickStatusSelect / Activity statuses), so any
 * admin-chosen color stays legible in light and dark themes. An inactive
 * status still renders (Projects keep it) with an "(inactive)" suffix.
 */
export function ProjectStatusBadge({ status, className }: { status: ProjectStatusDisplay; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", className)}
      data-project-status-id={status.id}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: status.color }} aria-hidden="true" />
      {status.label}
      {status.isActive === false && <span className="text-muted-foreground font-normal">(inactive)</span>}
    </span>
  );
}
