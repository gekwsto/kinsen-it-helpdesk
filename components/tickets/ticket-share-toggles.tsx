"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

interface TicketShareTogglesProps {
  ticketId: string;
  initialShareWithDepartment: boolean;
  initialShareWithSubDepartment: boolean;
  hasSubDepartment: boolean;
  canShareDepartment: boolean;
  canShareSubDepartment: boolean;
}

/** Visible only when the caller is the ticket owner or holds ticket.share.department/subdepartment — computed server-side in app/(main)/tickets/[id]/page.tsx. */
export function TicketShareToggles({
  ticketId,
  initialShareWithDepartment,
  initialShareWithSubDepartment,
  hasSubDepartment,
  canShareDepartment,
  canShareSubDepartment,
}: TicketShareTogglesProps) {
  const [shareWithDepartment, setShareWithDepartment] = useState(initialShareWithDepartment);
  const [shareWithSubDepartment, setShareWithSubDepartment] = useState(initialShareWithSubDepartment);
  const [saving, setSaving] = useState<string | null>(null);

  const patch = async (field: "shareWithDepartment" | "shareWithSubDepartment", value: boolean) => {
    setSaving(field);
    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update sharing");
      }
      if (field === "shareWithDepartment") setShareWithDepartment(value);
      else setShareWithSubDepartment(value);
      toast.success("Sharing updated");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update sharing");
      // revert optimistic UI isn't needed — state wasn't changed until success above
    } finally {
      setSaving(null);
    }
  };

  if (!canShareDepartment && !canShareSubDepartment) return null;

  return (
    <div className="space-y-2">
      {canShareDepartment && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="h-4 w-4 rounded"
            checked={shareWithDepartment}
            disabled={saving === "shareWithDepartment"}
            onChange={(e) => patch("shareWithDepartment", e.target.checked)}
          />
          <span className="text-sm">Share with my department</span>
          {saving === "shareWithDepartment" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </label>
      )}
      {canShareSubDepartment && (
        <label className={`flex items-center gap-2 ${hasSubDepartment ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
          <input
            type="checkbox"
            className="h-4 w-4 rounded"
            checked={shareWithSubDepartment}
            disabled={!hasSubDepartment || saving === "shareWithSubDepartment"}
            onChange={(e) => patch("shareWithSubDepartment", e.target.checked)}
          />
          <span className="text-sm">Share with my sub-department</span>
          {saving === "shareWithSubDepartment" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </label>
      )}
      {canShareSubDepartment && !hasSubDepartment && (
        <p className="text-xs text-muted-foreground pl-6">Select a subdepartment before sharing with it.</p>
      )}
    </div>
  );
}
