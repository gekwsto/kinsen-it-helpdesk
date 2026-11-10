"use client";

import { useState } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";

export interface UserAvatarTooltipPerson {
  id: string;
  name?: string | null;
  image?: string | null;
}

interface UserAvatarTooltipProps {
  user: UserAvatarTooltipPerson;
  /** Every role this person holds in the CALLER's specific context (e.g. ["Assigned To", "Owner"]) — resolved once by the caller (see lib/activities/activity-user-roles.ts), never re-derived here. */
  roles: string[];
  avatarClassName?: string;
  fallbackClassName?: string;
}

/**
 * Hover/focus/tap preview for a SINGLE user avatar chip — shows that
 * person's name plus every role they hold in this specific context (e.g. a
 * person who is both an Activity's Owner and one of its assignedUsers
 * shows both, not just one). Distinct from MemberPreview (which previews an
 * entire GROUP's names behind one shared trigger) — this wraps each
 * individual avatar chip itself. Requires a `<TooltipProvider>` ancestor,
 * same convention as every other Tooltip usage in this codebase.
 *
 * Uses a <span role="button"> rather than a real <button> as the trigger —
 * these chips are frequently rendered inside an already-clickable row
 * <Link>, and a real <button> nested inside an <a> is invalid HTML;
 * tabIndex + role="button" keeps it keyboard-focusable (so Radix's own
 * focus-triggered open path still works) without that nesting problem.
 */
export function UserAvatarTooltip({ user, roles, avatarClassName, fallbackClassName }: UserAvatarTooltipProps) {
  const [open, setOpen] = useState(false);
  const displayName = user.name?.trim() || "Unnamed";
  const roleText = roles.join(", ");

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="button"
          className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          aria-label={roleText ? `${displayName} — ${roleText}` : displayName}
          onClick={(e) => {
            // Same touch-tap affordance as MemberPreview: a tap toggles the
            // tooltip directly instead of bubbling into the row's own
            // navigation Link.
            e.preventDefault();
            e.stopPropagation();
            setOpen((prev) => !prev);
          }}
        >
          <Avatar className={avatarClassName}>
            <AvatarImage src={user.image ?? undefined} />
            <AvatarFallback className={fallbackClassName}>{getInitials(user.name)}</AvatarFallback>
          </Avatar>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="px-2.5 py-1.5">
        <p className="text-xs font-medium">{displayName}</p>
        {roleText && <p className="text-[11px] text-muted-foreground">{roleText}</p>}
      </TooltipContent>
    </Tooltip>
  );
}
