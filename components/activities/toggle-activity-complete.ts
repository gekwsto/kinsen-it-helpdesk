"use client";

/**
 * Single implementation of the completion toggle, shared by the activity
 * detail page, the activity list/card checkbox, and the project detail
 * page's activity row checkbox — previously only the detail page
 * (activity-detail-client.tsx) had a working version of this; the others
 * were `readOnly`. Toggling always sends both fields together so they never
 * drift apart (PATCH /api/activities/[id] also rejects a mismatched pair —
 * see the consistency guard there).
 */
export async function toggleActivityComplete(activityId: string, currentlyCompleted: boolean): Promise<{ isCompleted: boolean; status: string; progress: number }> {
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
    throw new Error(err.error ?? "Failed to update activity");
  }
  const updated = await res.json();
  // progress is always derived server-side from the new status (see
  // lib/activities/activity-progress.ts) — returned here so callers that
  // track it locally (e.g. activity-list.tsx's table view) don't go stale.
  return { isCompleted: updated.isCompleted, status: updated.status, progress: updated.progress };
}
