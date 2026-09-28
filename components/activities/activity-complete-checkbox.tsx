"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";
import { NAV_LOADER_IGNORE_ATTR } from "@/lib/navigation-loader";
import type { ProjectRollupResult } from "@/lib/projects/progress-rollup";

export interface ActivityToggleResult {
  isCompleted: boolean;
  status: string;
  progress: number;
  statusLabel: string;
  statusColor: string;
  projectRollups: ProjectRollupResult[];
}

interface ActivityCompleteCheckboxProps {
  activityId: string;
  initialIsCompleted: boolean;
  className?: string;
  /**
   * Called with the authoritative PATCH response once a toggle succeeds —
   * the caller (e.g. the Project detail page's own client-managed Activities
   * card) applies this directly to its local state (this row's own
   * status/statusLabel/statusColor, plus the affected project's rolled-up
   * progress/counters). There is no other reconciliation step: the PATCH
   * response already carries everything needed, so this component never
   * triggers a route refresh or otherwise re-fetches the page.
   */
  onToggled?: (result: ActivityToggleResult) => void;
}

/**
 * Small interactive checkbox for use inside an otherwise server-rendered
 * row that's itself wrapped in a <Link> (e.g. the project detail page's
 * activity list) — stops the click from bubbling to the parent Link so
 * toggling doesn't also navigate.
 *
 * Also marked with NAV_LOADER_IGNORE_ATTR: the app's global navigation
 * loader (components/layout/navigation-loader.tsx) listens for clicks in
 * the CAPTURE phase, which always runs before this component's own
 * onClick — so by the time preventDefault()/stopPropagation() below run,
 * that listener has already seen a click inside a <Link> and would arm the
 * full-page blocking overlay for a navigation that's deliberately never
 * going to happen, leaving the overlay stuck showing until its own safety
 * timeout. The attribute tells that listener to skip this click entirely;
 * see NAV_LOADER_IGNORE_ATTR's own doc comment in lib/navigation-loader.ts.
 */
export function ActivityCompleteCheckbox({ activityId, initialIsCompleted, className, onToggled }: ActivityCompleteCheckboxProps) {
  const [isCompleted, setIsCompleted] = useState(initialIsCompleted);
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const previous = isCompleted;
    setToggling(true);
    setIsCompleted(!previous);
    try {
      const result = await toggleActivityComplete(activityId, previous);
      setIsCompleted(result.isCompleted);
      onToggled?.(result);
    } catch (error: any) {
      setIsCompleted(previous);
      toast.error(error.message ?? "Failed to update activity");
    } finally {
      setToggling(false);
    }
  };

  if (toggling) {
    // Also guards against the wrapping <Link>'s own navigation, exactly
    // like the checkbox's own onClick below — without this, a click landing
    // on the spinner while a toggle is in flight had no handler of its own,
    // so the click fell through to the row's native <a> navigation for
    // real (the nav-loader-ignore attribute only stops the OVERLAY from
    // arming; it was never a substitute for actually preventing the click's
    // default action).
    return (
      <Loader2
        {...{ [NAV_LOADER_IGNORE_ATTR]: true }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={`h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground ${className ?? ""}`}
      />
    );
  }

  return (
    <input
      {...{ [NAV_LOADER_IGNORE_ATTR]: true }}
      type="checkbox"
      checked={isCompleted}
      onChange={() => {}}
      onClick={handleToggle}
      className={`h-4 w-4 rounded flex-shrink-0 cursor-pointer ${className ?? ""}`}
    />
  );
}
