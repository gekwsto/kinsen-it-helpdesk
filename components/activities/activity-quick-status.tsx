"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ActivityStatus } from "@prisma/client";
import { QuickStatusSelect, type QuickStatusOption } from "@/components/status/quick-status-select";

export interface ActivityStatusUpdate {
  status: string;
  statusLabel: string;
  statusColor: string;
  progress: number;
  isCompleted: boolean;
  completedAt: string | null;
}

interface ActivityQuickStatusProps {
  activityId: string;
  currentStatus: string;
  /** Authoritative current-status label/color — pass `activity.statusLabel`/`activity.statusColor` directly (the same fields the status badge renders), never derived from `statuses`. See QuickStatusSelect's own doc comment for why. */
  currentStatusLabel: string;
  currentStatusColor?: string;
  statuses: QuickStatusOption[];
  /** "loading" | "ready" | "error" for `statuses` — see QuickStatusSelect's doc comment. Distinguishes "still fetching"/"fetch failed" from a genuinely empty (zero-configured) list. */
  optionsState?: "loading" | "ready" | "error";
  /** Whether the current user holds activity.edit in this Activity's department — PATCH /api/activities/[id] independently re-checks this; this only governs whether the control is interactive. */
  canEdit: boolean;
  onChanged: (updated: ActivityStatusUpdate) => void;
}

/**
 * Activity-specific quick-status behavior: calls the SAME canonical
 * PATCH /api/activities/[id] the standalone Edit form and the existing
 * "Mark Complete" toggle (components/activities/toggle-activity-complete.ts)
 * both already use — no separate/duplicated status-transition logic.
 *
 * `isCompleted` is derived the same way toggle-activity-complete.ts
 * derives it: an exact equality check against the ActivityStatus.COMPLETED
 * enum member (the fixed, semantic "this IS completion" value baked into
 * the Prisma schema itself), never a name/label/string-content heuristic.
 * Sending it alongside `status` is REQUIRED — PATCH /api/activities/[id]
 * validates the two fields are consistent, and Activity.isCompleted would
 * otherwise silently drift out of sync with the new status.
 *
 * Because this hits the exact same route, selecting the department's
 * configured completion status here produces byte-for-byte the same
 * persisted result (progress derived from ActivityProgressConfig,
 * completedAt stamped, parent Project rollup recalculated) as the old
 * "Mark Complete" button did — see the final report for the equivalence
 * proof.
 */
export function ActivityQuickStatus({ activityId, currentStatus, currentStatusLabel, currentStatusColor, statuses, optionsState, canEdit, onChanged }: ActivityQuickStatusProps) {
  const [loading, setLoading] = useState(false);

  const handleSelect = async (statusId: string) => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/activities/${activityId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: statusId,
          isCompleted: statusId === ActivityStatus.COMPLETED,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(typeof err.error === "string" ? err.error : "Failed to update status");
      }
      const updated = await res.json();
      // Always the server's own computed values — progress/completion are
      // derived server-side (ActivityProgressConfig) and must never be
      // fabricated client-side.
      onChanged({
        status: updated.status,
        statusLabel: updated.statusLabel,
        statusColor: updated.statusColor,
        progress: updated.progress,
        isCompleted: updated.isCompleted,
        completedAt: updated.completedAt ?? null,
      });
      toast.success("Status updated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update status");
    } finally {
      setLoading(false);
    }
  };

  return (
    <QuickStatusSelect
      currentStatusId={currentStatus}
      currentLabel={currentStatusLabel}
      currentColor={currentStatusColor}
      options={statuses}
      optionsState={optionsState}
      disabled={!canEdit}
      loading={loading}
      onSelect={handleSelect}
      ariaLabel="Change activity status"
    />
  );
}
