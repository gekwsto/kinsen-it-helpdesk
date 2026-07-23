"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Clock, ShieldCheck, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PriorityPolicy {
  id: string;
  name: string;
  color: string;
  level: number;
  departmentId: string | null;
  department?: { id: string; name: string } | null;
  firstResponseHours: number;
  resolutionHours: number;
  /** Whether a saved SlaPolicy row exists (vs. just showing the 8h/48h fallback) — drives the "Reset to default" button. */
  hasPolicy?: boolean;
}

interface DepartmentOption {
  id: string;
  name: string;
}

export interface WorkspaceSlaManagerProps {
  isEnabled: boolean;
  priorities: PriorityPolicy[];
  departmentOptions: DepartmentOption[];
  /** Set when the department isn't user-choosable at all (non-Admin scoped view, or the /admin/departments/[id]/sla entry point). */
  fixedDepartmentId?: string;
  mode: "scoped" | "all";
  initialViewDepartmentId?: string;
  /** Gates the Save button and the hour inputs. */
  canEdit: boolean;
  /** Gates the per-row "Reset to default" button. */
  canDelete: boolean;
}

export function WorkspaceSlaManager({
  isEnabled: initialEnabled,
  priorities: initialPriorities,
  departmentOptions,
  fixedDepartmentId,
  mode,
  initialViewDepartmentId,
  canEdit,
  canDelete,
}: WorkspaceSlaManagerProps) {
  const [isEnabled, setIsEnabled] = useState(initialEnabled);
  const [priorities, setPriorities] = useState(initialPriorities);
  const [viewDepartmentId, setViewDepartmentId] = useState<string>(fixedDepartmentId ?? initialViewDepartmentId ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);

  const showDepartmentPicker = !fixedDepartmentId && departmentOptions.length > 0;
  // Only reachable in mode="all" (System Admin only, per the page-level
  // gate) — a department-scoped save always includes `departmentId` in the
  // PUT body, and the route hard-403s an isEnabled change whenever
  // `departmentId` is present (a department can never toggle the
  // system-wide feature flag). See app/api/admin/sla/route.ts.
  const showEnableToggle = mode === "all";

  const effectiveDepartmentId = fixedDepartmentId ?? viewDepartmentId;

  const refetchForView = async (value: string) => {
    setViewDepartmentId(value);
    setLoading(true);
    try {
      const url = value ? `/api/admin/sla?departmentId=${value}` : "/api/admin/sla";
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setIsEnabled(data.isEnabled ?? false);
        setPriorities(data.priorities ?? []);
      }
    } catch {
      toast.error("Failed to load SLA settings");
    } finally {
      setLoading(false);
    }
  };

  const updatePolicy = (id: string, field: "firstResponseHours" | "resolutionHours", value: string) => {
    const num = parseInt(value);
    if (isNaN(num) || num < 1) return;
    setPriorities((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: num } : p)));
  };

  // Every priority is now strictly department-owned — a scoped view only
  // ever receives its own department's rows to begin with, so there's no
  // "global, read-only" row to distinguish anymore. Editability is just canEdit.
  const isRowEditable = (_p: PriorityPolicy) => canEdit;

  const handleReset = async (p: PriorityPolicy) => {
    setResettingId(p.id);
    try {
      const res = await fetch(`/api/admin/sla?priorityId=${p.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to reset SLA hours");
      }
      setPriorities((prev) => prev.map((row) => (row.id === p.id ? { ...row, firstResponseHours: 8, resolutionHours: 48, hasPolicy: false } : row)));
      toast.success(`${p.name} SLA reset to default`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to reset SLA hours");
    } finally {
      setResettingId(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body =
        mode === "all"
          ? {
              isEnabled,
              policies: priorities.map((p) => ({ priorityId: p.id, firstResponseHours: p.firstResponseHours, resolutionHours: p.resolutionHours })),
            }
          : {
              departmentId: effectiveDepartmentId,
              policies: priorities
                .filter((p) => p.departmentId === effectiveDepartmentId)
                .map((p) => ({ priorityId: p.id, firstResponseHours: p.firstResponseHours, resolutionHours: p.resolutionHours })),
            };
      const res = await fetch("/api/admin/sla", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to save SLA settings");
      }
      toast.success("SLA settings saved");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to save SLA settings");
    } finally {
      setSaving(false);
    }
  };

  const hasOwnPriorities = mode === "all" ? priorities.length > 0 : priorities.some((p) => p.departmentId === effectiveDepartmentId);

  return (
    <div className="space-y-6 max-w-2xl">
      {showDepartmentPicker && (
        <div className="flex items-center gap-2">
          <Select value={viewDepartmentId || (mode === "all" ? "__all__" : "")} onValueChange={(v) => refetchForView(v === "__all__" ? "" : v)}>
            <SelectTrigger className="h-8 w-[220px] text-sm">
              <SelectValue placeholder="Viewing…" />
            </SelectTrigger>
            <SelectContent>
              {mode === "all" && <SelectItem value="__all__">All Departments</SelectItem>}
              {departmentOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      )}

      {showEnableToggle && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-base">SLA Enforcement</CardTitle>
                  <CardDescription className="text-sm mt-0.5">
                    {isEnabled ? "SLA timers are active and tracking deadlines." : "SLA is currently disabled. No deadlines are tracked."}
                  </CardDescription>
                </div>
              </div>
              <Switch checked={isEnabled} onCheckedChange={setIsEnabled} aria-label="Toggle SLA" />
            </div>
          </CardHeader>
        </Card>
      )}

      {!showEnableToggle && !isEnabled && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          SLA enforcement is currently disabled system-wide. Only a System Admin can enable it (switch workspace to
          &quot;All Workspaces&quot; if you hold that role). Hours below still save, but aren&apos;t enforced until then.
        </p>
      )}

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Deadlines by Priority</CardTitle>
          </div>
          <CardDescription>
            Times are in hours from ticket creation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="grid grid-cols-[1fr_140px_140px_40px] gap-4 px-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Priority</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">First Response</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Resolution</span>
            <span />
          </div>

          <div className="divide-y rounded-lg border">
            {priorities.map((p) => {
              const editable = isRowEditable(p);
              return (
                <div key={p.id} className="grid grid-cols-[1fr_140px_140px_40px] gap-4 items-center px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                      {p.department?.name ?? "Department"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={p.firstResponseHours}
                      onChange={(e) => updatePolicy(p.id, "firstResponseHours", e.target.value)}
                      className="h-8 w-20 text-sm"
                      disabled={!editable || (!isEnabled && showEnableToggle)}
                    />
                    <span className="text-xs text-muted-foreground">h</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={p.resolutionHours}
                      onChange={(e) => updatePolicy(p.id, "resolutionHours", e.target.value)}
                      className="h-8 w-20 text-sm"
                      disabled={!editable || (!isEnabled && showEnableToggle)}
                    />
                    <span className="text-xs text-muted-foreground">h</span>
                  </div>
                  <div>
                    {canDelete && editable && p.hasPolicy && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Reset to default hours"
                        onClick={() => handleReset(p)}
                        disabled={resettingId === p.id}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {resettingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {priorities.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">No active priorities visible here.</p>
            )}
          </div>

          {mode === "scoped" && !hasOwnPriorities && (
            <p className="text-xs text-muted-foreground pt-2 px-1">
              This department has no priorities of its own yet — create one under Priorities to set department-specific SLA hours.
            </p>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || (mode === "scoped" && !hasOwnPriorities)}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Settings
          </Button>
        </div>
      )}
    </div>
  );
}
