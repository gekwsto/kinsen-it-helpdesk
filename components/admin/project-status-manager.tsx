"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const CANONICAL_PROJECT_STATUS_LABELS: Record<string, string> = {
  PLANNING: "Planning",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export interface AdminProjectStatus {
  id: string;
  key: string;
  label: string;
  color: string;
  sortOrder: number;
  isActive: boolean;
  canonicalStatus: string;
  isSystem: boolean;
  usageCount: number;
}

type FormState = { id: string | null; label: string; color: string; sortOrder: string; canonicalStatus: string; isActive: boolean };

const EMPTY_FORM: FormState = { id: null, label: "", color: "#94a3b8", sortOrder: "", canonicalStatus: "IN_PROGRESS", isActive: true };

/**
 * Administration -> Project Statuses (ADMIN only). Same Card + Table +
 * Dialog conventions as the Ticket/Activity Status admin screens. Business
 * protections are enforced server-side (lib/services/project-status-service.ts);
 * the disabled controls here only mirror them:
 *  - system statuses: no delete, no lifecycle remapping; the system
 *    PLANNING status stays active (default for new Projects);
 *  - statuses used by Projects: no delete, no lifecycle remapping.
 */
export function ProjectStatusManager({ initialStatuses }: { initialStatuses: AdminProjectStatus[] }) {
  const router = useRouter();
  const [statuses, setStatuses] = useState(initialStatuses);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    const res = await fetch("/api/admin/project-statuses");
    if (res.ok) setStatuses(await res.json());
    router.refresh();
  };

  const editing = form?.id ? statuses.find((s) => s.id === form.id) ?? null : null;
  const lifecycleLocked = !!editing && (editing.isSystem || editing.usageCount > 0);
  const activeLocked = !!editing && editing.isSystem && editing.canonicalStatus === "PLANNING";

  const save = async () => {
    if (!form) return;
    if (!form.label.trim()) return toast.error("A label is required.");
    if (form.sortOrder !== "" && (!Number.isInteger(Number(form.sortOrder)) || Number(form.sortOrder) < 0)) return toast.error("Display order must be a whole number (0 or more).");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        label: form.label.trim(),
        color: form.color,
        isActive: form.isActive,
        ...(form.sortOrder !== "" ? { sortOrder: Number(form.sortOrder) } : {}),
        ...(!lifecycleLocked ? { canonicalStatus: form.canonicalStatus } : {}),
      };
      const res = await fetch(form.id ? `/api/admin/project-statuses/${form.id}` : "/api/admin/project-statuses", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Failed to save the Project Status");
      toast.success(form.id ? "Project Status updated" : "Project Status created");
      setForm(null);
      await reload();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: AdminProjectStatus, isActive: boolean) => {
    const res = await fetch(`/api/admin/project-statuses/${s.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isActive }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(body.error ?? "Failed to update the Project Status");
    toast.success(`${s.label} ${isActive ? "activated" : "deactivated"}`);
    await reload();
  };

  const remove = async (s: AdminProjectStatus) => {
    if (!window.confirm(`Delete the Project Status "${s.label}"?`)) return;
    const res = await fetch(`/api/admin/project-statuses/${s.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(body.error ?? "Failed to delete the Project Status");
    toast.success(`${s.label} deleted`);
    await reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setForm({ ...EMPTY_FORM })}>
          <Plus className="h-4 w-4 mr-2" />
          New Project Status
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table data-testid="project-status-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Lifecycle State</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Projects</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statuses.map((s) => {
                  const planningSystem = s.isSystem && s.canonicalStatus === "PLANNING";
                  const deleteBlocked = s.isSystem || s.usageCount > 0;
                  return (
                    <TableRow key={s.id} data-status-key={s.key}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full border" style={{ backgroundColor: s.color }} aria-hidden="true" />
                          <span className="font-medium">{s.label}</span>
                          {s.isSystem && <Badge variant="secondary" className="text-[10px]">System</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{s.key}</TableCell>
                      <TableCell>{CANONICAL_PROJECT_STATUS_LABELS[s.canonicalStatus] ?? s.canonicalStatus}</TableCell>
                      <TableCell>{s.sortOrder}</TableCell>
                      <TableCell data-testid="usage-count">{s.usageCount}</TableCell>
                      <TableCell>
                        <Switch
                          checked={s.isActive}
                          disabled={planningSystem && s.isActive}
                          onCheckedChange={(v) => toggleActive(s, v)}
                          aria-label={`${s.label} active`}
                          title={planningSystem ? "The default status for new Projects must stay active." : undefined}
                        />
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${s.label}`}
                          onClick={() => setForm({ id: s.id, label: s.label, color: s.color, sortOrder: String(s.sortOrder), canonicalStatus: s.canonicalStatus, isActive: s.isActive })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${s.label}`}
                          disabled={deleteBlocked}
                          title={s.isSystem ? "System statuses can't be deleted." : s.usageCount > 0 ? `Used by ${s.usageCount} Project(s).` : undefined}
                          onClick={() => remove(s)}
                        >
                          {s.isSystem ? <Lock className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.id ? `Edit ${editing?.label ?? "Project Status"}` : "New Project Status"}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ps-label">Label</Label>
                <Input id="ps-label" value={form.label} maxLength={50} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ps-color">Color</Label>
                  <div className="flex items-center gap-2">
                    <input id="ps-color" type="color" className="h-9 w-12 rounded border bg-background" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
                    <Input aria-label="Color hex" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="font-mono" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ps-order">Display Order</Label>
                  <Input id="ps-order" type="number" min={0} value={form.sortOrder} placeholder="Last" onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Lifecycle State</Label>
                <Select value={form.canonicalStatus} onValueChange={(v) => setForm({ ...form, canonicalStatus: v })} disabled={lifecycleLocked}>
                  <SelectTrigger aria-label="Lifecycle State">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CANONICAL_PROJECT_STATUS_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {editing?.isSystem
                    ? "System statuses keep their lifecycle state."
                    : editing && editing.usageCount > 0
                      ? `Used by ${editing.usageCount} Project(s) — the lifecycle state can't be changed. Create a new status instead.`
                      : "Drives business behaviour (completion, Feedback, overdue). Several statuses may share a lifecycle state."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="ps-active" checked={form.isActive} disabled={activeLocked} onCheckedChange={(v) => setForm({ ...form, isActive: v })} />
                <Label htmlFor="ps-active">Active</Label>
                {activeLocked && <span className="text-xs text-muted-foreground">Default for new Projects — always active.</span>}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
