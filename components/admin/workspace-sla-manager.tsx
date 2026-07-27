"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Clock, ShieldCheck, RotateCcw, Plus, Trash2, Ban, CheckCircle2 } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PriorityPolicy {
  id: string;
  name: string;
  color: string;
  level: number;
  isActive: boolean;
  departmentId: string | null;
  department?: { id: string; name: string } | null;
  /** null means no SlaPolicy row exists for this priority — render "SLA not configured", never fabricate 8h/48h. */
  firstResponseHours: number | null;
  resolutionHours: number | null;
  hasPolicy: boolean;
  /** How many tickets reference this priority — a real delete is blocked server-side (and disabled here) while this is > 0. */
  ticketCount: number;
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
  /** Gates the "New Level" button and hours-configuration on a not-yet-configured row. */
  canCreate?: boolean;
  /** Gates the Save button, hour inputs, name/order fields, and Disable/Enable. */
  canEdit: boolean;
  /** Gates the per-row Reset and Delete Level actions. */
  canDelete: boolean;
}

/** A fetch() whose success response we don't otherwise read the body of — draining it (even though 204/empty) avoids a Chromium DevTools quirk where an unread response stream can be reported as net::ERR_ABORTED despite completing successfully. */
async function drain(res: Response) {
  await res.text().catch(() => {});
}

export function WorkspaceSlaManager({
  isEnabled: initialEnabled,
  priorities: initialPriorities,
  departmentOptions,
  fixedDepartmentId,
  mode,
  initialViewDepartmentId,
  canCreate = false,
  canEdit,
  canDelete,
}: WorkspaceSlaManagerProps) {
  const [isEnabled, setIsEnabled] = useState(initialEnabled);
  const [priorities, setPriorities] = useState(initialPriorities);
  const [viewDepartmentId, setViewDepartmentId] = useState<string>(fixedDepartmentId ?? initialViewDepartmentId ?? "");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

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
      } else {
        await drain(res);
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

  const isRowEditable = (_p: PriorityPolicy) => canEdit;

  const [resetConfirmTarget, setResetConfirmTarget] = useState<PriorityPolicy | null>(null);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<PriorityPolicy | null>(null);

  // ── Reset (hours only, back to starter values) — distinct from Delete ──
  const handleReset = async (p: PriorityPolicy) => {
    setResettingId(p.id);
    try {
      const res = await fetch("/api/admin/sla", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: effectiveDepartmentId, action: "reset", priorityId: p.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to reset SLA hours");
      }
      const data = await res.json();
      setPriorities((prev) => prev.map((row) => (row.id === p.id ? { ...row, firstResponseHours: data.firstResponseHours, resolutionHours: data.resolutionHours, hasPolicy: true } : row)));
      toast.success(`${p.name} SLA hours reset to defaults`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to reset SLA hours");
    } finally {
      setResettingId(null);
    }
  };

  const confirmReset = async () => {
    if (!resetConfirmTarget) return;
    const target = resetConfirmTarget;
    setResetConfirmTarget(null);
    await handleReset(target);
  };

  // ── Disable / Enable (isActive) — historical ticket references are never affected ──
  const handleToggleActive = async (p: PriorityPolicy) => {
    setTogglingId(p.id);
    const nextActive = !p.isActive;
    try {
      const res = await fetch("/api/admin/priorities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: p.id, isActive: nextActive }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update level");
      }
      await drain(res);
      setPriorities((prev) => prev.map((row) => (row.id === p.id ? { ...row, isActive: nextActive } : row)));
      toast.success(nextActive ? `${p.name} enabled for new selection` : `${p.name} disabled — existing tickets keep showing it`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update level");
    } finally {
      setTogglingId(null);
    }
  };

  // ── Delete Level (real removal of the priority + its cascade-deleted policy) — only when unreferenced ──
  const handleDelete = async () => {
    if (!deleteConfirmTarget) return;
    const target = deleteConfirmTarget;
    setDeleteConfirmTarget(null);
    setDeletingId(target.id);
    try {
      const res = await fetch(`/api/admin/priorities?id=${target.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete level");
      }
      await drain(res);
      setPriorities((prev) => prev.filter((row) => row.id !== target.id));
      toast.success(`${target.name} deleted`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete level");
    } finally {
      setDeletingId(null);
    }
  };

  // ── Create Level (priority + policy, atomic: POST /api/admin/priorities already ensures a starter SlaPolicy row) ──
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addLevel, setAddLevel] = useState(1);
  const [addColor, setAddColor] = useState("#6366f1");
  const [adding, setAdding] = useState(false);

  const openAdd = () => {
    setAddName("");
    setAddLevel(priorities.length > 0 ? Math.max(...priorities.map((p) => p.level)) + 1 : 1);
    setAddColor("#6366f1");
    setAddOpen(true);
  };

  const handleAdd = async () => {
    if (!addName.trim() || !effectiveDepartmentId) return;
    setAdding(true);
    try {
      const res = await fetch("/api/admin/priorities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: effectiveDepartmentId, name: addName.trim(), level: addLevel, color: addColor }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to add level");
      }
      const created = await res.json();
      setPriorities((prev) => [
        ...prev,
        {
          id: created.id,
          name: created.name,
          color: created.color,
          level: created.level,
          isActive: created.isActive,
          departmentId: created.departmentId,
          department: null,
          firstResponseHours: 8,
          resolutionHours: 48,
          hasPolicy: true,
          ticketCount: 0,
        },
      ]);
      toast.success(`${created.name} added`);
      setAddOpen(false);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to add level");
    } finally {
      setAdding(false);
    }
  };

  // ── Save (hours only — name/order/active are saved immediately by their own inline controls above) ──
  const handleSave = async () => {
    setSaving(true);
    try {
      const configuredRows = (mode === "all" ? priorities : priorities.filter((p) => p.departmentId === effectiveDepartmentId))
        .filter((p) => p.firstResponseHours != null && p.resolutionHours != null);
      const body =
        mode === "all"
          ? {
              isEnabled,
              policies: configuredRows.map((p) => ({ priorityId: p.id, firstResponseHours: p.firstResponseHours, resolutionHours: p.resolutionHours })),
            }
          : {
              departmentId: effectiveDepartmentId,
              policies: configuredRows.map((p) => ({ priorityId: p.id, firstResponseHours: p.firstResponseHours, resolutionHours: p.resolutionHours })),
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
      await drain(res);
      setPriorities((prev) => prev.map((p) => (configuredRows.some((c) => c.id === p.id) ? { ...p, hasPolicy: true } : p)));
      toast.success("SLA settings saved");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to save SLA settings");
    } finally {
      setSaving(false);
    }
  };

  const hasOwnPriorities = mode === "all" ? priorities.length > 0 : priorities.some((p) => p.departmentId === effectiveDepartmentId);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
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
        {canCreate && effectiveDepartmentId && (
          <Button variant="outline" size="sm" onClick={openAdd} className="ml-auto">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Level
          </Button>
        )}
      </div>

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
            <CardTitle className="text-base">SLA Levels</CardTitle>
          </div>
          <CardDescription>
            Each level is a ticket priority owned by one department. Response/resolution times are in hours from ticket creation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          <div className="grid grid-cols-[1fr_120px_120px_70px_70px] gap-3 px-3 pb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Level</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">First Response</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Resolution</span>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active</span>
            <span />
          </div>

          <div className="divide-y rounded-lg border">
            {priorities.map((p) => {
              const editable = isRowEditable(p);
              return (
                <div key={p.id} data-testid={`sla-row-${p.id}`} className={`grid grid-cols-[1fr_120px_120px_70px_70px] gap-3 items-center px-3 py-3 ${!p.isActive ? "opacity-60" : ""}`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-block h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: p.color }} />
                    <span className="text-sm font-medium truncate">{p.name}</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200 flex-shrink-0">
                      {p.department?.name ?? "Department"}
                    </span>
                    {!p.isActive && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-gray-100 text-gray-600 border-gray-200 flex-shrink-0">
                        Disabled
                      </span>
                    )}
                  </div>
                  {p.firstResponseHours == null ? (
                    <span className="text-xs font-medium text-amber-700">SLA not configured</span>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={1}
                        value={p.firstResponseHours}
                        onChange={(e) => updatePolicy(p.id, "firstResponseHours", e.target.value)}
                        className="h-8 w-16 text-sm"
                        disabled={!editable || (!isEnabled && showEnableToggle)}
                      />
                      <span className="text-xs text-muted-foreground">h</span>
                    </div>
                  )}
                  {p.resolutionHours == null ? (
                    <span className="text-xs font-medium text-amber-700">SLA not configured</span>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        min={1}
                        value={p.resolutionHours}
                        onChange={(e) => updatePolicy(p.id, "resolutionHours", e.target.value)}
                        className="h-8 w-16 text-sm"
                        disabled={!editable || (!isEnabled && showEnableToggle)}
                      />
                      <span className="text-xs text-muted-foreground">h</span>
                    </div>
                  )}
                  <div>
                    {editable && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={p.isActive ? "Disable — keeps historical tickets, hides from new selection" : "Enable for new selection"}
                        onClick={() => handleToggleActive(p)}
                        disabled={togglingId === p.id}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      >
                        {togglingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : p.isActive ? <Ban className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5">
                    {canDelete && editable && p.hasPolicy && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Reset hours to defaults"
                        onClick={() => setResetConfirmTarget(p)}
                        disabled={resettingId === p.id}
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                      >
                        {resettingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title={p.ticketCount > 0 ? `Cannot delete — ${p.ticketCount} ticket(s) use this level. Disable it instead.` : "Delete level"}
                        onClick={() => setDeleteConfirmTarget(p)}
                        disabled={p.ticketCount > 0 || deletingId === p.id}
                        className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10 disabled:text-muted-foreground"
                      >
                        {deletingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {priorities.length === 0 && (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">No levels visible here.</p>
            )}
          </div>

          {mode === "scoped" && !hasOwnPriorities && (
            <p className="text-xs text-muted-foreground pt-2 px-1">
              This department has no levels of its own yet — use &quot;New Level&quot; above to create one.
            </p>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || (mode === "scoped" && !hasOwnPriorities)}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Hours
          </Button>
        </div>
      )}

      {/* Reset confirm dialog — distinct action from Delete: overwrites hours back to starter values, never touches the level itself. */}
      <Dialog open={resetConfirmTarget != null} onOpenChange={(o) => { if (!o) setResetConfirmTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset SLA hours</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Reset <strong className="text-foreground">{resetConfirmTarget?.name}</strong>&apos;s response/resolution hours
              back to the starter values (8h first response / 48h resolution)? Any custom hours you&apos;ve set will be
              overwritten. The level itself (name, order, active state) is not affected.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirmTarget(null)} disabled={resettingId != null}>Cancel</Button>
            <Button variant="destructive" onClick={confirmReset} disabled={resettingId != null}>
              {resettingId != null && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reset hours
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog — real removal of the level (priority + its policy), only ever reachable when ticketCount is 0. */}
      <Dialog open={deleteConfirmTarget != null} onOpenChange={(o) => { if (!o) setDeleteConfirmTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete SLA level</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Permanently delete <strong className="text-foreground">{deleteConfirmTarget?.name}</strong>? This removes the
              level and its SLA hours entirely — it cannot be undone. This is only available because no tickets currently
              use it; if any did, disable it instead to preserve their history.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmTarget(null)} disabled={deletingId != null}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deletingId != null}>
              {deletingId != null && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete level
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Level dialog — atomically creates a department-scoped TicketPriority + its starter SlaPolicy (POST /api/admin/priorities already ensures both). */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New SLA level</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Name</label>
              <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="e.g. Urgent" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Order (higher = more urgent, shown first)</label>
              <Input type="number" value={addLevel} onChange={(e) => setAddLevel(parseInt(e.target.value, 10) || 1)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Color</label>
              <input type="color" value={addColor} onChange={(e) => setAddColor(e.target.value)} className="h-9 w-16 rounded border" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={adding || !addName.trim()}>
              {adding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
