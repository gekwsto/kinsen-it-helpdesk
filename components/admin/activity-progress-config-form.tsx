"use client";

import { useState } from "react";
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
import { STATUS_LABEL, STATUS_BAR, ACTIVITY_STATUS_KEYS } from "@/components/gantt/status-colors";
import { cn } from "@/lib/utils";

export interface ActivityProgressRow {
  status: ActivityStatus;
  progressPercent: number;
  isEnabled: boolean;
  sortOrder: number;
}

export interface ActivityStatusDisplayRow {
  status: ActivityStatus;
  label: string;
  color: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface ActivityProgressConfigFormProps {
  departmentId: string;
  initialRows: ActivityProgressRow[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /**
   * When provided (non-empty) an internal department picker is rendered and
   * this component OWNS department-switching itself: a fresh GET is issued
   * client-side and local state is fully replaced — never left to a
   * server-driven prop change, which React does NOT automatically re-sync
   * into an already-initialized useState. Omitted entirely on the
   * department-fixed deep-link page (/admin/departments/[id]/activity-progress),
   * which has no picker at all.
   */
  departmentOptions?: DepartmentOption[];
  /**
   * This department's own Activity Status label/color (from the SAME
   * ActivityStatusConfig table the Activity Statuses admin screen edits) —
   * so a renamed status (e.g. Sales' TODO -> "New Activity") reads correctly
   * here too, instead of falling back to the generic enum label. Reloaded
   * alongside the progress rows on every department switch so the two never
   * drift apart.
   */
  statusDisplayRows: ActivityStatusDisplayRow[];
}

function clampPercent(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function sortRows(rows: ActivityProgressRow[]): ActivityProgressRow[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Full create/edit/disable/delete/reorder for one department's Activity
 * Progress rows (lib/activities/activity-progress.ts is the single
 * resolution logic every consumer — Activity List/Grid/cards, Project
 * progress, Dashboard, Gantt, Resource Planning, APIs — reads from; this
 * form is the only place those rows are ever written). ActivityStatus is a
 * fixed enum, so "create" means adding back a status this department
 * doesn't currently have a row for, never inventing a new status value.
 *
 * Department switching is entirely client-owned (see `departmentOptions`
 * above) — a real fix for a bug where switching the on-page department
 * dropdown (a query-param-only navigation, which React/Next.js does NOT
 * remount a client component for) left this component's `rows` state
 * showing the PREVIOUS department's percentages under the NEW department's
 * label, so an edit-then-Save while "on" the new department silently
 * overwrote its real rows with the old department's stale values.
 */
export function ActivityProgressConfigForm({ departmentId, initialRows, canCreate, canEdit, canDelete, departmentOptions = [], statusDisplayRows }: ActivityProgressConfigFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [activeDepartmentId, setActiveDepartmentId] = useState(departmentId);
  const [rows, setRows] = useState<ActivityProgressRow[]>(sortRows(initialRows));
  const [lastLoadedRows, setLastLoadedRows] = useState<ActivityProgressRow[]>(sortRows(initialRows));
  const [display, setDisplay] = useState<ActivityStatusDisplayRow[]>(statusDisplayRows);
  const [loadingDepartment, setLoadingDepartment] = useState(false);
  const [pendingDepartmentId, setPendingDepartmentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [addOpen, setAddOpen] = useState(false);
  const [addStatus, setAddStatus] = useState<string>("");
  const [addPercent, setAddPercent] = useState(0);
  const [adding, setAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ActivityProgressRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isDirty = JSON.stringify(sortRows(rows)) !== JSON.stringify(lastLoadedRows);

  const presentStatuses = new Set(rows.map((r) => r.status));
  const availableToAdd = ACTIVITY_STATUS_KEYS.filter((s) => !presentStatuses.has(s as ActivityStatus));

  const displayMap = new Map(display.map((d) => [d.status, d]));
  const labelFor = (status: string) => displayMap.get(status as ActivityStatus)?.label ?? STATUS_LABEL[status] ?? status;
  const colorFor = (status: string) => displayMap.get(status as ActivityStatus)?.color;

  function updateRow(status: ActivityStatus, patch: Partial<ActivityProgressRow>) {
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

  /** Fully replaces local state from a fresh, department-scoped GET — the only place `rows`/`activeDepartmentId` are ever set together, so they can never drift apart (e.g. showing dept A's rows under dept B's id). */
  const loadDepartment = async (id: string) => {
    setLoadingDepartment(true);
    try {
      const [res, displayRes] = await Promise.all([
        fetch(`/api/admin/activity-progress?departmentId=${id}`),
        fetch(`/api/admin/activity-statuses?departmentId=${id}`),
      ]);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to load this department's configuration");
        await res.text().catch(() => {});
        await displayRes.text().catch(() => {});
        return;
      }
      const data = await res.json();
      const sorted = sortRows(data.rows ?? []);
      setRows(sorted);
      setLastLoadedRows(sorted);
      if (displayRes.ok) {
        const displayData = await displayRes.json();
        setDisplay(displayData.rows ?? []);
      } else {
        await displayRes.text().catch(() => {});
      }
      setActiveDepartmentId(id);
      setErrors({});
      // Keeps the URL bookmarkable/refresh-stable without letting the URL
      // change be what drives the fetch (avoids re-introducing the stale-
      // remount bug this component exists to fix) — scroll:false and no
      // router.refresh() so this never triggers a server re-render/remount.
      const params = new URLSearchParams(searchParams.toString());
      params.set("departmentId", id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    } catch {
      toast.error("Failed to load this department's configuration");
    } finally {
      setLoadingDepartment(false);
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
      if (!Number.isInteger(row.progressPercent) || row.progressPercent < 0 || row.progressPercent > 100) {
        nextErrors[row.status] = "Must be a whole number between 0 and 100.";
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Fix the highlighted percentages before saving.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/admin/activity-progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: activeDepartmentId, rows }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // Blocked (e.g. item_in_use from the usage-analysis guard) — never
        // leave the local switch/percent state showing a change that was
        // NOT actually persisted; re-sync from the server's real state so
        // the UI can't display a false "success" for a rejected action.
        const refetch = await fetch(`/api/admin/activity-progress?departmentId=${activeDepartmentId}`).catch(() => null);
        if (refetch?.ok) {
          const data = await refetch.json();
          const sorted = sortRows(data.rows ?? []);
          setRows(sorted);
          setLastLoadedRows(sorted);
        } else {
          await refetch?.text().catch(() => {});
        }
        throw new Error(err.error ?? "Failed to save");
      }
      const data = await res.json();
      const sorted = sortRows(data.rows ?? []);
      setRows(sorted);
      setLastLoadedRows(sorted);
      toast.success("Activity progress mapping saved");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const openAdd = () => {
    setAddStatus(availableToAdd[0] ?? "");
    setAddPercent(0);
    setAddOpen(true);
  };

  const handleAdd = async () => {
    if (!addStatus) return;
    setAdding(true);
    try {
      const nextSortOrder = rows.length > 0 ? Math.max(...rows.map((r) => r.sortOrder)) + 1 : 0;
      const res = await fetch("/api/admin/activity-progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentId: activeDepartmentId, status: addStatus, progressPercent: clampPercent(addPercent), sortOrder: nextSortOrder }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to add status");
      }
      const created = await res.json();
      setRows((prev) => {
        const next = [...prev, { status: created.status, progressPercent: created.progressPercent, isEnabled: created.isEnabled, sortOrder: created.sortOrder }];
        setLastLoadedRows(sortRows(next));
        return next;
      });
      toast.success(`${labelFor(addStatus)} added`);
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
      const res = await fetch(`/api/admin/activity-progress?departmentId=${activeDepartmentId}&status=${deleteTarget.status}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete");
      }
      // A 204 has no body, but draining it anyway avoids a Chromium
      // DevTools quirk where an unread response stream on a fetch() can be
      // reported as net::ERR_ABORTED in the Network panel despite the
      // request having completed successfully (confirmed via CDP tracing —
      // responseReceived always fires before the spurious loadingFailed).
      await res.text().catch(() => {});
      setRows((prev) => {
        const next = prev.filter((r) => r.status !== deleteTarget.status);
        setLastLoadedRows(sortRows(next));
        return next;
      });
      toast.success(`${labelFor(deleteTarget.status)} removed`);
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
    <div className="space-y-4 max-w-lg">
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
          No activity progress rows configured for this department yet.
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
                  aria-label={`Move ${labelFor(row.status)} up`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(row.status, 1)}
                  disabled={!canEdit || i === sortedRows.length - 1}
                  aria-label={`Move ${labelFor(row.status)} down`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-20 disabled:pointer-events-none"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>

              <span className="flex items-center gap-2 text-sm flex-1 min-w-0">
                <span
                  className={cn("inline-block h-2 w-4 rounded-sm flex-shrink-0", !colorFor(row.status) && STATUS_BAR[row.status])}
                  style={colorFor(row.status) ? { backgroundColor: colorFor(row.status) } : undefined}
                />
                <span className="truncate">{labelFor(row.status)}</span>
              </span>

              <div className="flex flex-col items-end gap-0.5">
                <div className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    disabled={!canEdit}
                    value={row.progressPercent}
                    onChange={(e) => {
                      const num = parseInt(e.target.value, 10);
                      updateRow(row.status, { progressPercent: Number.isNaN(num) ? 0 : num });
                    }}
                    className={cn("h-8 w-20 text-sm", errors[row.status] && "border-destructive")}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
                {errors[row.status] && <span className="text-[10px] text-destructive">{errors[row.status]}</span>}
              </div>

              <Switch
                checked={row.isEnabled}
                onCheckedChange={(checked) => updateRow(row.status, { isEnabled: checked })}
                disabled={!canEdit}
                aria-label={`${row.isEnabled ? "Disable" : "Enable"} ${labelFor(row.status)}`}
              />

              {canDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Delete"
                  onClick={() => setDeleteTarget(row)}
                  className="text-destructive hover:bg-destructive/10 h-7 w-7 p-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
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
            <DialogTitle>Add activity progress status</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Status</label>
              <Select value={addStatus} onValueChange={setAddStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a status…" />
                </SelectTrigger>
                <SelectContent>
                  {availableToAdd.map((s) => (
                    <SelectItem key={s} value={s}>{labelFor(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Progress %</label>
              <Input
                type="number"
                min={0}
                max={100}
                value={addPercent}
                onChange={(e) => setAddPercent(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={adding || !addStatus}>
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
            <DialogTitle>Delete status mapping</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Remove the progress mapping for{" "}
              <strong className="text-foreground">{deleteTarget && labelFor(deleteTarget.status)}</strong>?
              Activities with this status will show &quot;Configuration required&quot; until you add it back.
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

      {/* Unsaved-changes confirm — switching department discards local edits, so this requires an explicit confirmation rather than silently discarding or (worse) silently keeping the wrong department's edited values on screen. */}
      <Dialog open={pendingDepartmentId != null} onOpenChange={(o) => { if (!o) setPendingDepartmentId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              You have unsaved percentage/enabled changes for the current department. Switching departments will discard
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
