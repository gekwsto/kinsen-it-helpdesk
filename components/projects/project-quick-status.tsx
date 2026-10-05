"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { QuickStatusSelect, type QuickStatusOption } from "@/components/status/quick-status-select";

interface ProjectQuickStatusProps {
  projectId: string;
  currentStatus: string;
  /** Authoritative current-status label — same value the header's own status badge renders, passed explicitly rather than looked up in `statuses` (kept symmetric with ActivityQuickStatus; see QuickStatusSelect's doc comment). */
  currentStatusLabel: string;
  statuses: QuickStatusOption[];
  /** Whether the current user holds project.edit in this Project's department — PATCH /api/projects/[id] independently re-checks this; this only governs whether the control is interactive. */
  canEdit: boolean;
  onChanged: (newStatus: string) => void;
}

/**
 * Project-specific quick-status behavior: calls the SAME canonical
 * PATCH /api/projects/[id] the standalone Project Edit form already uses —
 * no separate/duplicated status-update logic. Sends ONLY `{ status }`
 * (never the full Edit form payload), which the route's `.partial()`
 * validation schema and Prisma `update()` both already treat as "leave
 * every other field untouched" (confirmed: Prisma only writes keys present
 * in the update payload, and `memberIds`/`isGoal`/etc. being absent here
 * means their existing values are never touched).
 *
 * Confirmed-update (not optimistic): the visible status only changes once
 * the server responds successfully, so a failed request never needs an
 * explicit rollback — the UI simply never displayed the unpersisted value.
 */
export function ProjectQuickStatus({ projectId, currentStatus, currentStatusLabel, statuses, canEdit, onChanged }: ProjectQuickStatusProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSelect = async (statusId: string) => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(typeof err.error === "string" ? err.error : "Failed to update status");
      }
      const updated = await res.json();
      // The dropdown/badge themselves already reflect the new status
      // instantly via onChanged -> this Client Component's own local
      // state — never blocked on the refresh below. router.refresh() is
      // ADDITIONALLY needed because this Project detail page also renders
      // Server Component content that depends on the CURRENT Project
      // status read fresh from the DB (the Project Feedback card's own
      // eligibility — Project.status === COMPLETED — see
      // getProjectFeedbackEligibility in app/(main)/projects/[id]/page.tsx)
      // and any future status-dependent server-rendered section; without
      // this, that content stays stale (e.g. a still-visible Feedback
      // form after the Project just moved away from COMPLETED) until a
      // manual reload. Next.js preserves this component's own already-
      // updated client state across the refresh — it only re-renders the
      // Server Component tree with fresh data, never a visible flicker of
      // the dropdown/badge reverting.
      onChanged(updated.status);
      router.refresh();
      toast.success("Project status updated");
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
      options={statuses}
      disabled={!canEdit}
      loading={loading}
      onSelect={handleSelect}
      ariaLabel="Change project status"
    />
  );
}
