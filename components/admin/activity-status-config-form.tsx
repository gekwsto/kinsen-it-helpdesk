"use client";

import { useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { Loader2, ChevronUp, ChevronDown, Trash2, Plus } from "lucide-react";
import { ActivityStatus } from "@prisma/client";
import { ACTIVITY_STATUS_KEYS } from "@/components/gantt/status-colors";
import { cn } from "@/lib/utils";

export interface ActivityStatusRow {
  status: ActivityStatus;
  label: string;
  color: string;
  sortOrder: number;
  isEnabled: boolean;
  isTerminal: boolean;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface ActivityStatusConfigFormProps {
  departmentId: string;
  initialRows: ActivityStatusRow[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** When provided (non-empty), an internal department picker is rendered and this component owns department-switching itself. Omitted on the department-fixed deep-link page. */
  departmentOptions?: DepartmentOption[];
}

function sortRows(rows: ActivityStatusRow[]): ActivityStatusRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Full department-scoped Activity Status management — label, color,
 * sort order, enabled/disabled, terminal/non-terminal — for the fixed
 * ActivityStatus enum keys (TODO, IN_PROGRESS, ...). The internal key never
 * changes; only its display metadata per department does. Reads/writes the
 * SAME ActivityStatusConfig table lib/status-terminal.ts's isTerminal
 * resolution already used — never a second config system.
 *
 * Department switching mirrors ActivityProgressConfigForm's own fix for a
 * real stale-state bug: fully client-owned department state, a request-
 * token guard (not just sequential trust) so a slow response from a
 * department the user already navigated away from can never overwrite the
 * current one, and an unsaved-changes confirmation before discarding edits.
 */
export function ActivityStatusConfigForm({ departmentId, initialRows, canCreate, canEdit, canDelete, departmentOptions = [] }: ActivityStatusConfigFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [activeDepartmentId, setActiveDepartmentId] = useState(departmentId);
  const [rows, setRows] = useState<ActivityStatusRow[]>(sortRows(initialRows));
  const [lastLoadedRows, setLastLoadedRows] = useState<ActivityStatusRow[]>(sortRows(initialRows));
  const [loadingDepartment, setLoadingDepartment] = useState(false);
  const [pendingDepartmentId, setPendingDepartmentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requestTokenRef = useRef(0);

  const [addOpen, setAddOpen] = useState(false);
  const [addStatus, setAddStatus] = useState<string>("");
  const [addLabel, setAddLabel] = useState("");
  const [addColor, setAddColor] = useState("#94a3b8");
  const [adding, setAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ActivityStatusRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isDirty = JSON.stringify(sortRows(rows)) !== JSON.stringify(lastLoadedRows);

  const presentStatuses = new Set(rows.map((r) => r.status));
  const availableToAdd = ACTIVITY_STATUS_KEYS.filter((s) => !presentStatuses.has(s as ActivityStatus));

  function updateRow(status: ActivityStatus, patch: Partial<ActivityStatusRow>) {
    setRows((prev) => prev.map((r) => (r.status === status ? { ...r, ...patch } : r)));
  }

  function move(status: ActivityStatus, direction: -1 | 1) {
    setRows((prev) => {
      const sorted = [...prev].sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = sorted.findIndex((r) => r.status === status);
      const swapIdx = idx + direction;
      if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return prev;
      const a = sorted[idx];
      const b = sorted[swapIdx];
      const aOrder = a.sortOrder;
      const bOrder = b.sortOrder;
      return prev.map((r) => {
        if (r.status === a.status) return { ...r, sortOrder: bOrder };
        if (r.status === b.status) return { ...r, sortOrder: aOrder };
        return r;
      });
    });
  }

  /** Fully replaces local state from a fresh, department-scoped GET — guarded by an incrementing request token so a slow response from a department the user has already navigated away from (rapid Finance -> IT -> Sales clicking) can never overwrite the current one. */
  const loadDepartment = async (id: string) => {
    const token = ++requestTokenRef.current;
    setLoadingDepartment(true);
    try {
      const res = await fetch(`/api/admin/activity-statuses?departmentId=${id}`);
      if (token !== requestTokenRef.current) return; // a newer switch already superseded this one
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.message ?? err.error ?? "Failed to load this department's activity statuses");
        await res.text().catch(() => {});
        return;
      }
      const data = await res.json();
      if (token !== requestTokenRef.current) return;
      const sorted = sortRows(data.rows ?? []);
      setRows(sorted);
      setLastLoadedRows(sorted);
      setActiveDepartmentId(id);
      setErrors({});
      const params = new URLSearchParams(searchParams.toString());
      params.set("departmentId", id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    } catch {
      if (token === requestTokenRef.current) toast.error("Failed to load this department's activity statuses");
    } finally {
      if (token === requestTokenRef.current) setLoadingDepartment(false);
    }
  };

  const handleDepartmentSelect = (id: string) => {
    if (id === activeDepartmentId) return;
    if (isDirty) {
      setPendingDepartmentId(id);
      return;
    }
    loadDepartment(id);
  };

  const confirmDepartmentSwitch = async () => {
    if (!pendingDepartmentId) return;
    const target = pendingDepartmentId;
    setPendingDepartmentId(null);
    await loadDepartment(target);
  };

  const handleSave = async () => {
    const nextErrors: Record<string, string> = {};
    for (const row of rows) {
      if (!row.label.trim()) nextErrors[row.status] = "Label is required.";
      else if (!/^#[0-9A-Fa-f]{6}$/.test(row.color)) nextErrors[row.status] = "Color must be a valid hex value.";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Fix the highlighted fields before saving.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/activity-statuses", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: activeDepartmentId, rows }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Blocked (e.g. item_in_use) — re-sync from the server's real state
        // so the UI can never display a false "success" for a rejected action.
        const refetch = await fetch(`/api/admin/activity-statuses?departmentId=${activeDepartmentId}`).catch(() => null);
        if (refetch?.ok) {
          const data = await refetch.json();
          const sorted = sortRows(data.rows ?? []);
          setRows(sorted);
          setLastLoadedRows(sorted);
        } else {
          await refetch?.text().catch(() => {});
        }
        throw new Error(err.message ?? err.error ?? "Failed to save");
      }
      const data = await res.json();
      const sorted = sortRows(data.rows ?? []);
      setRows(sorted);
      setLastLoadedRows(sorted);
      toast.success("Activity statuses saved");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const openAdd = () => {
    setAddStatus(availableToAdd[0] ?? "");
    setAddLabel("");
    setAddColor("#94a3b8");
    setAddOpen(true);
  };

  const handleAdd = async () => {
    if (!addStatus || !addLabel.trim()) return;
    setAdding(true);
    try {
      const nextSortOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.sortOrder)) + 1 : 0;
      const res = await fetch("/api/admin/activity-statuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: activeDepartmentId, status: addStatus, label: addLabel.trim(), color: addColor, sortOrder: nextSortOrder }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? "Failed to add status");
      }
      const created = await res.json();
      setRows((prev) => {
        const next = [...prev, { status: created.status, label: created.label, color: created.color, sortOrder: created.sortOrder, isEnabled: created.isEnabled, isTerminal: created.isTerminal }];
        setLastLoadedRows(sortRows(next));
        return next;
      });
      toast.success(`${addLabel.trim()} added`);
      setAddOpen(false);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to add status");
    } finally {
      setAdding(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/activity-statuses?departmentId=${activeDepartmentId}&status=${deleteTarget.status}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? "Failed to delete");
      }
      // Drains the (empty, 204) response body — avoids a Chromium DevTools
      // quirk where an unread fetch() response can be reported as
      // net::ERR_ABORTED despite completing successfully.
      await res.text().catch(() => {});
      setRows((prev) => {
        const next = prev.filter((r) => r.status !== deleteTarget.status);
        setLastLoadedRows(sortRows(next));
        return next;
      });
      toast.success(`${deleteTarget.label} removed`);
      setDeleteTarget(null);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const sortedRows = sortRows(rows);
  const showDepartmentPicker = departmentOptions.length > 0;

  return (
    <div className="space-y-4 max-w-2xl">
      {showDepartmentPicker && (
        <div className="flex items-center gap-2">
          <Select value={activeDepartmentId} onValueChange={handleDepartmentSelect}>
            <SelectTrigger className="h-9 w-[220px] text-sm">
              <SelectValue placeholder="Choose a department…" />
            </SelectTrigger>
            <SelectContent>
              {departmentOptions.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loadingDepartment && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      )}

      {sortedRows.length === 0 ? (
        <div className="rounded-lg border py-10 text-center text-sm text-muted-foreground">
          No activity statuses configured for this department yet.
          {canCreate && <p className="mt-1">Add one below to get started.</p>}
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {sortedRows.map((row, i) => (
            <div key={row.status} className={cn("flex items-center gap-3 px-3 py-2.5", !row.isEnabled && "opacity-50")}>
              <div className="flex flex-col -my-1">
                <button
                  type="button"
                  onClick={() => move(row.status, -1)}
                  disabled={!canEdit || i === 0}
                  aria-label={`Move ${row.label} up`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(row.status, 1)}
                  disabled={!canEdit || i === sortedRows.length - 1}
                  aria-label={`Move ${row.label} down`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <span className="text-[10px] font-mono text-muted-foreground w-24 flex-shrink-0" title="Fixed internal key — never changes">{row.status}</span>

              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <input
                  type="color"
                  value={row.color}
                  onChange={(e) => updateRow(row.status, { color: e.target.value })}
                  disabled={!canEdit}
                  className="h-8 w-8 flex-shrink-0 cursor-pointer rounded border"
                  aria-label={`${row.label} color`}
                />
                <Input
                  value={row.label}
                  onChange={(e) => updateRow(row.status, { label: e.target.value })}
                  disabled={!canEdit}
                  className={cn("h-8 text-sm", errors[row.status] && "border-destructive")}
                  placeholder="Display label"
                />
              </div>

              <label className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                <Switch
                  checked={row.isTerminal}
                  onCheckedChange={(checked) => updateRow(row.status, { isTerminal: checked })}
                  disabled={!canEdit}
                  aria-label={`${row.label} is terminal (done/closed)`}
                />
                Terminal
              </label>

              <Switch
                checked={row.isEnabled}
                onCheckedChange={(checked) => updateRow(row.status, { isEnabled: checked })}
                disabled={!canEdit}
                aria-label={`${row.isEnabled ? "Disable" : "Enable"} ${row.label}`}
              />

              {canDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Delete"
                  onClick={() => setDeleteTarget(row)}
                  className="text-destructive hover:bg-destructive/10 h-7 w-7 p-0 flex-shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      {Object.keys(errors).length > 0 && (
        <p className="text-xs text-destructive">{Object.values(errors)[0]}</p>
      )}

      <div className="flex items-center justify-between gap-2">
        {canCreate && availableToAdd.length > 0 && (
          <Button variant="outline" size="sm" onClick={openAdd}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add status
          </Button>
        )}
        {canEdit && sortedRows.length > 0 && (
          <Button onClick={handleSave} disabled={saving} className="ml-auto">
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        )}
      </div>

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add activity status</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Status key</label>
              <Select value={addStatus} onValueChange={setAddStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a status…" />
                </SelectTrigger>
                <SelectContent>
                  {availableToAdd.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Display label</label>
              <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder="e.g. New Activity" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Color</label>
              <input type="color" value={addColor} onChange={(e) => setAddColor(e.target.value)} className="h-9 w-16 rounded border" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={adding || !addStatus || !addLabel.trim()}>
              {adding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={deleteTarget != null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete activity status</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Remove the <strong className="text-foreground">{deleteTarget?.label}</strong> ({deleteTarget?.status}) configuration for this department?
              Only possible while no activity currently uses it — prefer disabling instead if you might need it again.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Unsaved-changes confirm — switching department discards local edits. */}
      <Dialog open={pendingDepartmentId != null} onOpenChange={(o) => { if (!o) setPendingDepartmentId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              You have unsaved activity status changes for the current department. Switching departments will discard
              them — they were never saved. Continue?
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDepartmentId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDepartmentSwitch}>Discard and switch</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
