"use client";

import { useState } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials, cn } from "@/lib/utils";

export interface MemberPreviewPerson {
  id: string;
  name: string | null;
  image?: string | null;
}

interface MemberPreviewProps {
  /** The exact relation already rendered by the caller (Project.members / Activity.assignedUsers) — never a second, separately-fetched set. */
  members: MemberPreviewPerson[];
  /** e.g. "Members" or "Assigned" — heading inside the preview and part of the trigger's accessible name; never rendered as extra visible text beyond `children`. */
  label: string;
  /** The list's existing trigger markup (icon+count, avatar stack, etc.) — rendered completely unchanged; this component only adds the hover/focus/tap preview around it. */
  children: React.ReactNode;
  className?: string;
}

/**
 * Shared hover/focus/tap preview of a Project's members or an Activity's
 * assignees, for the existing List (table) views only — wraps whatever
 * trigger markup a list already renders (it is never redesigned) with a
 * Radix Tooltip that lists every member's name. Requires a `<TooltipProvider>`
 * ancestor (each list view wraps its own list-view render in one, same
 * convention already used by components/gantt/gantt-chart.tsx and
 * components/resource-planning/resource-timeline.tsx).
 *
 * Shows only name + avatar/initials — never email or any other field, even
 * though some callers' underlying data (e.g. Activity.assignedUsers) also
 * carries email for unrelated reasons; this component simply never reads it.
 *
 * No data is fetched here: `members` must already be part of the list's own
 * paginated query result (see project-list.tsx / activity-list.tsx).
 */
export function MemberPreview({ members, label, children, className }: MemberPreviewProps) {
  const [open, setOpen] = useState(false);
  const names = members.map((m) => m.name?.trim() || "Unnamed").join(", ");
  const accessibleLabel = members.length > 0 ? `${label}: ${names}` : `${label}: No members`;

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            className
          )}
          aria-label={accessibleLabel}
          onClick={(e) => {
            // Radix's own hover-open path is deliberately skipped for touch
            // pointers (a tap shouldn't behave like a hover) — this handler
            // is what gives touch an equivalent preview, by toggling the
            // SAME tooltip directly. It also unconditionally stops the tap
            // from reaching any ancestor row-level navigation, whether or
            // not one exists today.
            e.preventDefault();
            e.stopPropagation();
            setOpen((prev) => !prev);
          }}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="p-2 w-56">
        <p className="text-[11px] font-medium text-muted-foreground px-0.5 mb-1">{label}</p>
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground px-0.5 py-1">No members</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto space-y-1 pr-1">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-xs py-0.5">
                <Avatar className="h-5 w-5 flex-shrink-0">
                  <AvatarImage src={m.image ?? undefined} />
                  <AvatarFallback className="text-[8px]">{getInitials(m.name)}</AvatarFallback>
                </Avatar>
                <span className="truncate">{m.name?.trim() || "Unnamed"}</span>
              </li>
            ))}
          </ul>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
