"use client";

import { useState } from "react";
import Link from "next/link";
import { CalendarClock, ChevronDown, ChevronUp } from "lucide-react";
import type { ResourceEvent, ResourcePlanningResource } from "@/lib/services/resource-planning-service";

const STATUS_LABEL: Record<string, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

interface UnscheduledPanelProps {
  unscheduled: ResourceEvent[];
  resources: ResourcePlanningResource[];
}

/**
 * Card for activities in the current scope with no usable start/due date at
 * all — read-only in v1, no drag-to-schedule (see the plan). Collapsible so
 * it never has to eat space unless the viewer wants it open.
 *
 * Always full-width within whatever parent gives it: on desktop/laptop
 * that's the fixed-width left rail (resource-planning-filters.tsx renders
 * it directly under the Filters card, see the shared rail there), on mobile
 * it's rendered by the page below the timeline instead — it never sits
 * beside the timeline as its own right-hand column anymore, so it never
 * competes with the timeline for horizontal room.
 */
export function UnscheduledPanel({ unscheduled, resources }: UnscheduledPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const nameById = new Map(resources.map((r) => [r.id, r.name ?? r.email]));

  return (
    <div className="rounded-lg border bg-card flex flex-col w-full">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="flex items-center justify-between gap-2 p-3 border-b text-left hover:bg-muted/40 transition-colors"
        aria-expanded={!collapsed}
      >
        <div>
          <p className="text-sm font-medium">
            Unscheduled Activities{unscheduled.length > 0 && ` (${unscheduled.length})`}
          </p>
          {!collapsed && (
            <p className="text-xs text-muted-foreground mt-0.5">
              No start or due date — can&apos;t be placed on the timeline.
            </p>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        )}
      </button>

      {!collapsed && (
        <>
          {unscheduled.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-muted-foreground px-4">
              <CalendarClock className="h-6 w-6" />
              <p className="text-xs">Nothing unscheduled in this scope.</p>
            </div>
          ) : (
            <div className="divide-y overflow-y-auto max-h-[360px]">
              {unscheduled.map((e) => {
                const assigneeNames = e.assignedUserIds.map((id) => nameById.get(id)).filter(Boolean);
                return (
                  <Link
                    key={e.id}
                    href={`/activities/${e.id}`}
                    className="block p-3 hover:bg-muted/50 transition-colors"
                  >
                    <p className="text-sm font-medium truncate">{e.title}</p>
                    {e.projectTitle && <p className="text-xs text-muted-foreground truncate">{e.projectTitle}</p>}
                    <div className="flex items-center justify-between gap-2 mt-1">
                      <span className="text-xs text-muted-foreground truncate">
                        {assigneeNames.length > 0 ? assigneeNames.join(", ") : "Unassigned"}
                      </span>
                      <span className="text-[10px] text-muted-foreground flex-shrink-0">{STATUS_LABEL[e.status] ?? e.status}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
