"use client";

import { AlertTriangle, Check, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface QuickStatusOption {
  /** Stable status id — a Prisma enum member (e.g. "PLANNING", "TODO"), never a display name. */
  id: string;
  label: string;
  /** Optional hex/CSS color for the status dot. Omitted entirely when the entity type has no configured color (e.g. Project statuses today — see the final report). */
  color?: string;
}

interface QuickStatusSelectProps {
  currentStatusId: string;
  /**
   * Authoritative label/color for the CURRENTLY selected status — always
   * sourced from the entity's own record (e.g. `activity.statusLabel`/
   * `activity.statusColor`, the exact same fields the status badge next to
   * the title already renders from), never derived by searching `options`.
   *
   * `options` can arrive from a separate, slower fetch than the entity
   * itself (see ActivityDetailClient: the activity loads first, its
   * department's status list loads second) — searching `options` for the
   * trigger's own label means there is a real window where `options` is
   * still empty and the trigger falls back to the raw status id (e.g.
   * "TODO" instead of "To Do"), or — during a client-side navigation
   * between two entities before React settles — briefly disagrees with the
   * badge entirely. Requiring the caller to pass the current label/color
   * explicitly removes that class of bug structurally: the trigger and the
   * badge now always read from the same already-available value.
   */
  currentLabel: string;
  currentColor?: string;
  options: QuickStatusOption[];
  /**
   * Distinguishes "options is empty because it's still loading/failed" from
   * "options is empty because this department genuinely has zero
   * configured statuses" — an empty array alone is ambiguous between all
   * three. Defaults to "ready" so callers whose option list is always
   * synchronously available (e.g. ProjectQuickStatus, which computes the
   * full ProjectStatus enum inline — never fetched) don't need to pass
   * anything. The dropdown renders a distinct, explicit message for each
   * non-ready state instead of a silently blank menu.
   */
  optionsState?: "loading" | "ready" | "error";
  /** True when the caller lacks edit permission — the control is still visible (read access), just not interactive. */
  disabled?: boolean;
  /** True while a status-change request is in flight — disables the trigger and shows a spinner, blocking duplicate submissions. */
  loading?: boolean;
  onSelect: (statusId: string) => void;
  /** Accessible name for the trigger, e.g. "Change project status" / "Change activity status". */
  ariaLabel: string;
}

/**
 * Domain-agnostic quick-status dropdown — presentation and interaction
 * only. Contains no Project/Activity-specific API calls or business rules;
 * callers (ProjectQuickStatus, ActivityQuickStatus) own the update
 * behavior and pass in whatever `options`/`currentStatusId` are valid for
 * that entity's department, plus the `onSelect` callback that performs the
 * actual PATCH.
 *
 * The current status's own menu item is rendered `disabled` (Radix skips
 * onSelect for disabled items) rather than guarded manually — clicking the
 * already-active status is simply a no-op at the primitive level.
 */
export function QuickStatusSelect({
  currentStatusId,
  currentLabel,
  currentColor,
  options,
  optionsState = "ready",
  disabled = false,
  loading = false,
  onSelect,
  ariaLabel,
}: QuickStatusSelectProps) {
  const isInteractive = !disabled && !loading;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 font-normal"
          disabled={!isInteractive}
          aria-label={ariaLabel}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            currentColor && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: currentColor }}
                aria-hidden="true"
              />
            )
          )}
          <span className="truncate">{currentLabel}</span>
          {isInteractive && <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />}
        </Button>
      </DropdownMenuTrigger>
      {isInteractive && (
        <DropdownMenuContent align="end" className="min-w-[12rem]">
          {optionsState === "loading" ? (
            <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Loading statuses…
            </div>
          ) : optionsState === "error" ? (
            <div className="flex items-start gap-2 px-2 py-2 text-sm text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Could not load statuses.
            </div>
          ) : options.length === 0 ? (
            <div className="flex items-start gap-2 px-2 py-2 text-sm text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              No statuses configured for this department.
            </div>
          ) : (
            options.map((option) => {
              const isCurrent = option.id === currentStatusId;
              return (
                <DropdownMenuItem
                  key={option.id}
                  disabled={isCurrent}
                  onSelect={() => {
                    if (!isCurrent) onSelect(option.id);
                  }}
                  className={cn("gap-2", isCurrent && "font-medium")}
                >
                  <Check className={cn("h-3.5 w-3.5 shrink-0", isCurrent ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                  {option.color && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: option.color }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="truncate">{option.label}</span>
                </DropdownMenuItem>
              );
            })
          )}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
