"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { ActivityStatus } from "@prisma/client";
import { STATUS_LABEL, STATUS_BAR, ACTIVITY_STATUS_KEYS } from "@/components/gantt/status-colors";
import { cn } from "@/lib/utils";

interface ActivityProgressConfigFormProps {
  departmentId: string;
  initialConfig: Record<ActivityStatus, number>;
  canEdit: boolean;
}

/** Activity progress is derived from status (see lib/activities/activity-progress.ts) — this is where each department sets its own 6 percentages. All 6 statuses always exist; there's no create/delete here, only editing the percentage. */
export function ActivityProgressConfigForm({ departmentId, initialConfig, canEdit }: ActivityProgressConfigFormProps) {
  const [values, setValues] = useState<Record<string, number>>(initialConfig);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/activity-progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId, percentages: values }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to save");
      }
      toast.success("Activity progress mapping saved");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-md">
      <div className="divide-y rounded-lg border">
        {ACTIVITY_STATUS_KEYS.map((status) => (
          <div key={status} className="flex items-center justify-between gap-4 px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm">
              <span className={cn("inline-block h-2 w-4 rounded-sm", STATUS_BAR[status])} />
              {STATUS_LABEL[status] ?? status}
            </span>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={0}
                max={100}
                disabled={!canEdit}
                value={values[status] ?? 0}
                onChange={(e) => {
                  const num = parseInt(e.target.value);
                  setValues((prev) => ({ ...prev, [status]: isNaN(num) ? 0 : Math.min(100, Math.max(0, num)) }));
                }}
                className="h-8 w-20 text-sm"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </div>
        ))}
      </div>
      {canEdit && (
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save
        </Button>
      )}
    </div>
  );
}
