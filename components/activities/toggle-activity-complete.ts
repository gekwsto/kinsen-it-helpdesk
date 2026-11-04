"use client";

import type { ProjectRollupResult } from "@/lib/projects/progress-rollup";

/**
 * Single implementation of the completion toggle, shared by the activity
 * detail page, the activity list/card checkbox, and the project detail
 * page's activity row checkbox — previously only the detail page
 * (activity-detail-client.tsx) had a working version of this; the others
 * were `readOnly`. Toggling always sends both fields together so they never
 * drift apart (PATCH /api/activities/[id] also rejects a mismatched pair —
 * see the consistency guard there).
 */
export async function toggleActivityComplete(activityId: string, currentlyCompleted: boolean): Promise<{ isCompleted: boolean; status: string; progress: number; statusLabel: string; statusColor: string; projectRollups: ProjectRollupResult[]; completedAt: string | null; actualDays: number | null; actualCost: string | null }> {
  const res = await fetch(`/api/activities/${activityId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      isCompleted: !currentlyCompleted,
      status: !currentlyCompleted ? "COMPLETED" : "IN_PROGRESS",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? err.error ?? "Failed to update activity");
  }
  const updated = await res.json();
  // progress/statusLabel/statusColor are always derived server-side from
  // the new status and the activity's own department's config (see
  // lib/activities/activity-progress.ts, lib/services/activity-status-config.ts)
  // — returned here so callers that track them locally (e.g. activity-list.tsx's
  // table view) don't go stale or fall back to a hardcoded label/color.
  // `projectRollups` is the AWAITED rollup's own result for whichever
  // project(s) this toggle affected (never more than the activity's own
  // current/previous project — see the route's own doc comment) — callers
  // that render a parent Project's progress/counters (the Project detail
  // page) apply this directly instead of re-fetching anything.
  // completedAt/actualDays — both server-derived on this SAME transition
  // (see app/api/activities/[id]/route.ts's own authoritative COMPLETED-
  // transition boundary) — surfaced here the same way progress/statusLabel/
  // statusColor already are (and the same way ActivityStatusUpdate/
  // ActivityQuickStatus already does for the Activity detail page's own
  // quick-status control), so a caller that renders either (both Project
  // Activity cards) never goes stale waiting for a page refresh. null on
  // reopen, a fresh value on (re)completion — never fabricated here.
  // actualCost — server-derived on this SAME transition (taskSubTypeCost ×
  // actualDays, see computeActivityFinancials) — a reopen clears it back to
  // "0" immediately here, re-completing returns the freshly-recalculated
  // amount, never the previous one.
  return { isCompleted: updated.isCompleted, status: updated.status, progress: updated.progress, statusLabel: updated.statusLabel, statusColor: updated.statusColor, projectRollups: updated.projectRollups ?? [], completedAt: typeof updated.completedAt === "string" ? updated.completedAt : null, actualDays: typeof updated.actualDays === "number" ? updated.actualDays : null, actualCost: typeof updated.actualCost === "string" ? updated.actualCost : null };
}
