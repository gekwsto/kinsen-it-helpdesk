"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Loader2, Ban, ShieldCheck, Pencil, Trash2 } from "lucide-react";

// ─── Shared types ───────────────────────────────────────────────────────────

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "textarea" | "color" | "number" | "checkbox";
  required?: boolean;
  placeholder?: string;
  /** Checkbox-only helper text shown next to the label. */
  helpText?: string;
}

export type ExtraColumn =
  | { type: "field"; header: string; field: string }
  | { type: "badges"; header: string; badges: Array<{ field: string; label: string; className: string }> };

export interface ConfigItem {
  id: string;
  name: string;
  departmentId: string | null;
  department?: { id: string; name: string } | null;
  isActive?: boolean;
  _count?: { tickets: number };
  [key: string]: unknown;
}

export interface DepartmentOption {
  id: string;
  name: string;
}

export interface WorkspaceConfigManagerProps {
  entityLabel: string; // "Category"
  entityLabelPlural: string; // "Categories"
  apiEndpoint: string; // "/api/admin/categories"
  fields: ConfigField[];
  extraColumns?: ExtraColumn[];
  items: ConfigItem[];
  /** Every department the current user may target — empty when no picker should ever render. */
  departmentOptions: DepartmentOption[];
  /**
   * Set (including to a specific id) when the record's department is NOT
   * user-choosable at all — the /admin/departments/[id]/* entry points, and
   * any non-Admin user viewing their single scoped workspace. Renders a
   * read-only badge instead of any Select.
   */
  fixedDepartmentId?: string;
  /**
   * "scoped": exactly one department is ever in view (the active workspace,
   * or an Admin's in-page override of it) — the department picker (when
   * `fixedDepartmentId` is absent) never offers "All Departments" and the
   * create form never offers "Global default".
   * "all": the active workspace is "All Workspaces" (System Admin only,
   * enforced by the caller) — the picker offers "All Departments" as a
   * list filter, and the create form requires an explicit department OR
   * "Global default" choice, never defaulting silently.
   */
  mode: "scoped" | "all";
  /** Seeds the picker/filter — a department id in "scoped" mode, or undefined/"" for the unfiltered "all" view. */
  initialViewDepartmentId?: string;
  /** Only meaningful in mode="all" — whether "Global default" is offered as a create target (System Admin only). */
  canCreateGlobal: boolean;
  /**
   * "soft": Delete always deactivates (isActive:false), reversible via the
   * same toggle — Categories/Priorities/Statuses.
   * "hard-when-unused": a real delete, blocked (409 item_in_use) while any
   * ticket references the row — Cancel Reasons. Toggle Active/Inactive is
   * a SEPARATE control in this mode (PATCH only, never the DELETE verb).
   */
  deleteSemantics: "soft" | "hard-when-unused";
  /** Gates the Add button — backend still enforces this independently, this only hides the control. */
  canCreate: boolean;
  /** Gates the Edit button and reactivating an inactive row (PATCH-based). */
  canEdit: boolean;
  /** Gates deactivating an active row (DELETE-based) and the cancel-reason-style hard Delete. */
  canDelete: boolean;
}

// Renders the field inputs as plain JSX values (not a nested component) so
// AdminConfigTable's exact bug — a component defined inside another
// component's render body, recreated (and therefore remounted) every
// keystroke — can never happen here. Called directly as `{renderFields(...)}`
// in the tree below, never as `<RenderFields />`.
function renderFields(
  fields: ConfigField[],
  form: Record<string, unknown>,
  setForm: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
) {
  return fields.map((field) => {
    if (field.type === "checkbox") {
      return (
        <label key={field.key} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-input"
            checked={Boolean(form[field.key])}
            onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.checked }))}
          />
          {field.label}
          {field.helpText && <span className="text-xs text-muted-foreground">— {field.helpText}</span>}
        </label>
      );
    }
    return (
      <div key={field.key} className="space-y-2">
        <Label htmlFor={field.key}>
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </Label>
        {field.type === "textarea" ? (
          <Textarea
            id={field.key}
            placeholder={field.placeholder}
            value={(form[field.key] as string) ?? ""}
            onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.value }))}
            rows={2}
          />
        ) : field.type === "color" ? (
          <div className="flex items-center gap-3">
            <input
              type="color"
              id={field.key}
              value={(form[field.key] as string) ?? "#6366f1"}
              onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.value }))}
              className="h-10 w-16 cursor-pointer rounded border"
            />
            <Input
              value={(form[field.key] as string) ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.value }))}
              className="font-mono"
              placeholder="#6366f1"
            />
          </div>
        ) : (
          <Input
            id={field.key}
            type={field.type}
            placeholder={field.placeholder}
            value={(form[field.key] as string | number) ?? ""}
            onChange={(e) =>
              setForm((p) => ({ ...p, [field.key]: field.type === "number" ? parseInt(e.target.value) : e.target.value }))
            }
          />
        )}
      </div>
    );
  });
}

function friendlyError(err: { error?: unknown; code?: string }, fallback: string): string {
  if (typeof err.error === "string" && err.error.trim()) return err.error;
  return fallback;
}

function getNestedValue(obj: ConfigItem, path: string): unknown {
  return path.split(".").reduce((acc: any, key) => acc?.[key], obj);
}

function renderExtraColumn(col: ExtraColumn, item: ConfigItem) {
  if (col.type === "field") {
    const value = getNestedValue(item, col.field);
    return <span className="text-sm text-muted-foreground">{value != null ? String(value) : "—"}</span>;
  }
  const active = col.badges.filter(({ field }) => getNestedValue(item, field));
  if (active.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {active.map(({ label, className }) => (
        <span key={label} className={`text-xs px-1.5 py-0.5 rounded ${className}`}>
          {label}
        </span>
      ))}
    </span>
  );
}

function DepartmentBadge({ item, departmentOptions }: { item: ConfigItem; departmentOptions: DepartmentOption[] }) {
  if (!item.departmentId) {
    return (
      <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200">
        Global default
      </span>
    );
  }
  const name = item.department?.name ?? departmentOptions.find((d) => d.id === item.departmentId)?.name ?? "Department";
  return (
    <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
      {name}
    </span>
  );
}

const GLOBAL_OPTION_VALUE = "__global__";

export function WorkspaceConfigManager({
  entityLabel,
  entityLabelPlural,
  apiEndpoint,
  fields,
  extraColumns = [],
  items: initialItems,
  departmentOptions,
  fixedDepartmentId,
  mode,
  initialViewDepartmentId,
  canCreateGlobal,
  deleteSemantics,
  canCreate,
  canEdit,
  canDelete,
}: WorkspaceConfigManagerProps) {
  const [items, setItems] = useState(initialItems);
  const [listLoading, setListLoading] = useState(false);

  // "" here means "All Departments" (mode="all" only) — the list filter,
  // independent of the create form's own department choice below. Never
  // touches the global workspace cookie — this is a page-local view only.
  const [viewDepartmentId, setViewDepartmentId] = useState<string>(fixedDepartmentId ?? initialViewDepartmentId ?? "");
  const showDepartmentPicker = !fixedDepartmentId && departmentOptions.length > 0;

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<Record<string, unknown>>({});
  // Separate from viewDepartmentId — the create target is ALWAYS an explicit
  // choice, never silently inherited from whatever the list filter happens
  // to be set to (mode="all" requirement).
  const [createDepartmentId, setCreateDepartmentId] = useState<string>("");

  const [editItem, setEditItem] = useState<ConfigItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // A single confirm dialog covers both "deactivate" (soft) and "delete"
  // (hard, cancel-reason-only) — reactivating is non-destructive/reversible
  // and never needs confirmation.
  const [confirmTarget, setConfirmTarget] = useState<ConfigItem | null>(null);
  const [confirmKind, setConfirmKind] = useState<"deactivate" | "delete" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);

  const refetchForView = async (value: string) => {
    setViewDepartmentId(value);
    setListLoading(true);
    try {
      const url = value ? `${apiEndpoint}?departmentId=${value}` : apiEndpoint;
      const res = await fetch(url);
      if (res.ok) setItems(await res.json());
    } catch {
      toast.error(`Failed to load ${entityLabelPlural.toLowerCase()}`);
    } finally {
      setListLoading(false);
    }
  };

  const defaultFormValues = () => Object.fromEntries(fields.map((f) => [f.key, f.type === "color" ? "#6366f1" : f.type === "checkbox" ? false : ""]));

  const openCreate = () => {
    setForm(defaultFormValues());
    setCreateDepartmentId(fixedDepartmentId ?? (viewDepartmentId || ""));
    setCreateOpen(true);
  };

  const openEdit = (item: ConfigItem) => {
    setEditItem(item);
    setForm(Object.fromEntries(fields.map((f) => [f.key, item[f.key] ?? (f.type === "checkbox" ? false : "")])));
    setEditOpen(true);
  };

  const resolvedCreateDepartmentId = fixedDepartmentId ?? (createDepartmentId === GLOBAL_OPTION_VALUE ? null : createDepartmentId || null);
  const createDisabled =
    !fixedDepartmentId && createDepartmentId === "" /* forces an explicit department/global choice */;

  const handleCreate = async () => {
    if (createDisabled) return;
    setCreating(true);
    try {
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, departmentId: resolvedCreateDepartmentId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(friendlyError(err, `Failed to create ${entityLabel.toLowerCase()}`));
      }
      const created = await res.json();
      // Only splice into the visible list if it actually belongs to the
      // current filter — otherwise leave the list as-is (still correct,
      // just doesn't show a row the current view wouldn't include anyway).
      const belongsToView = !viewDepartmentId || created.departmentId === null || created.departmentId === viewDepartmentId;
      if (belongsToView) {
        setItems((prev) => [...prev, created].sort((a, b) => (a.name as string).localeCompare(b.name as string)));
      }
      toast.success(`${entityLabel} created`);
      setCreateOpen(false);
    } catch (error: any) {
      toast.error(error.message ?? `Failed to create ${entityLabel.toLowerCase()}`);
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = async () => {
    if (!editItem) return;
    setSaving(true);
    try {
      const res = await fetch(apiEndpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editItem.id, ...form }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(friendlyError(err, `Failed to update ${entityLabel.toLowerCase()}`));
      }
      const updated = await res.json();
      setItems((prev) => prev.map((i) => (i.id === editItem.id ? { ...i, ...updated } : i)));
      toast.success(`${entityLabel} updated`);
      setEditOpen(false);
    } catch (error: any) {
      toast.error(error.message ?? `Failed to update ${entityLabel.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  // Performs the actual toggle API call — reactivating (item currently
  // inactive) calls this directly (no confirmation needed, reversible);
  // deactivating (item currently active) only reaches this after the user
  // confirms in the dialog below.
  const performToggle = async (item: ConfigItem) => {
    setTogglingId(item.id);
    try {
      if (deleteSemantics === "soft" && item.isActive) {
        const res = await fetch(`${apiEndpoint}?id=${item.id}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(friendlyError(err, "Failed to deactivate"));
        }
      } else {
        const res = await fetch(apiEndpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, isActive: !item.isActive }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(friendlyError(err, "Failed to update"));
        }
      }
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, isActive: !i.isActive } : i)));
      toast.success(item.isActive ? `${entityLabel} deactivated` : `${entityLabel} activated`);
      return true;
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update");
      return false;
    } finally {
      setTogglingId(null);
    }
  };

  const handleToggleClick = (item: ConfigItem) => {
    if (item.isActive) {
      setConfirmTarget(item);
      setConfirmKind("deactivate");
      setConfirmOpen(true);
    } else {
      void performToggle(item);
    }
  };

  const performHardDelete = async (item: ConfigItem): Promise<boolean> => {
    try {
      const res = await fetch(`${apiEndpoint}?id=${item.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(friendlyError(err, `Failed to delete ${entityLabel.toLowerCase()}`));
        return false;
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast.success(`${entityLabel} deleted`);
      return true;
    } catch (error: any) {
      toast.error(error.message ?? `Failed to delete ${entityLabel.toLowerCase()}`);
      return false;
    }
  };

  const openHardDeleteConfirm = (item: ConfigItem) => {
    setConfirmTarget(item);
    setConfirmKind("delete");
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    if (!confirmTarget || !confirmKind) return;
    setConfirming(true);
    const ok = confirmKind === "deactivate" ? await performToggle(confirmTarget) : await performHardDelete(confirmTarget);
    setConfirming(false);
    if (ok) {
      setConfirmOpen(false);
      setConfirmTarget(null);
      setConfirmKind(null);
    }
  };

  const hasColorField = fields.some((f) => f.key === "color");
  const hasDescriptionField = fields.some((f) => f.key === "description");
  const columnCount = 2 + (hasColorField ? 1 : 0) + extraColumns.length + (hasDescriptionField ? 1 : 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? entityLabel.toLowerCase() : entityLabelPlural.toLowerCase()}
          </span>
          {showDepartmentPicker && (
            <Select value={viewDepartmentId || (mode === "all" ? "__all__" : "")} onValueChange={(v) => refetchForView(v === "__all__" ? "" : v)}>
              <SelectTrigger className="h-8 w-[200px] text-sm">
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
          )}
          {listLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        {canCreate && (
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add {entityLabel}
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Name</TableHead>
              {hasColorField && <TableHead className="w-24">Color</TableHead>}
              {extraColumns.map((c) => (
                <TableHead key={c.header}>{c.header}</TableHead>
              ))}
              {hasDescriptionField && <TableHead>Description</TableHead>}
              <TableHead>Scope</TableHead>
              <TableHead className="w-16">Status</TableHead>
              <TableHead className="w-28">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} className={item.isActive === false ? "opacity-50" : undefined}>
                <TableCell className="font-medium">{item.name}</TableCell>
                {hasColorField && (
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="h-5 w-5 rounded-full border" style={{ backgroundColor: item.color as string }} />
                      <span className="text-xs font-mono text-muted-foreground">{item.color as string}</span>
                    </div>
                  </TableCell>
                )}
                {extraColumns.map((c) => (
                  <TableCell key={c.header}>{renderExtraColumn(c, item)}</TableCell>
                ))}
                {hasDescriptionField && (
                  <TableCell className="text-muted-foreground text-sm">{(item.description as string) ?? "—"}</TableCell>
                )}
                <TableCell>
                  <DepartmentBadge item={item} departmentOptions={departmentOptions} />
                </TableCell>
                <TableCell>
                  <span className={`text-xs font-medium ${item.isActive === false ? "text-muted-foreground" : "text-green-700"}`}>
                    {item.isActive === false ? "Inactive" : "Active"}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-0.5">
                    {canEdit && (
                      <Button size="sm" variant="ghost" title="Edit" onClick={() => openEdit(item)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {togglingId === item.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground mx-1.5" />
                    ) : (
                      (item.isActive ? canDelete : canEdit) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={item.isActive ? "Deactivate" : "Activate"}
                          onClick={() => handleToggleClick(item)}
                          className={item.isActive ? "text-orange-500 hover:text-orange-600 hover:bg-orange-50" : "text-green-600 hover:text-green-700 hover:bg-green-50"}
                        >
                          {item.isActive ? <Ban className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                        </Button>
                      )
                    )}
                    {deleteSemantics === "hard-when-unused" && canDelete && (() => {
                      const ticketCount = item._count?.tickets ?? 0;
                      const inUse = ticketCount > 0;
                      return (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={
                            inUse
                              ? `Used by ${ticketCount} ticket${ticketCount === 1 ? "" : "s"} — deactivate instead`
                              : "Delete"
                          }
                          disabled={inUse}
                          className="text-destructive hover:bg-destructive/10 disabled:opacity-30 disabled:pointer-events-none"
                          onClick={() => openHardDeleteConfirm(item)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      );
                    })()}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={columnCount} className="text-center text-sm text-muted-foreground py-8">
                  No {entityLabelPlural.toLowerCase()} yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) setForm({}); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {entityLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {!fixedDepartmentId && (
              <div className="space-y-2">
                <Label>Department</Label>
                <Select value={createDepartmentId} onValueChange={setCreateDepartmentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a department…" />
                  </SelectTrigger>
                  <SelectContent>
                    {mode === "all" && canCreateGlobal && (
                      <SelectItem value={GLOBAL_OPTION_VALUE}>Global default</SelectItem>
                    )}
                    {departmentOptions.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {renderFields(fields, form, setForm)}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || createDisabled}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog — department is fixed to the record's own scope, never moved between departments */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {entityLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {editItem && (
              <div className="space-y-2">
                <Label>Department</Label>
                <div>
                  <DepartmentBadge item={editItem} departmentOptions={departmentOptions} />
                </div>
              </div>
            )}
            {renderFields(fields, form, setForm)}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm dialog — covers deactivating (soft) and hard-deleting (cancel-reason-style) */}
      <Dialog open={confirmOpen} onOpenChange={(o) => { setConfirmOpen(o); if (!o) { setConfirmTarget(null); setConfirmKind(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmKind === "delete" ? `Delete ${entityLabel}` : `Deactivate ${entityLabel}`}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              {confirmKind === "delete" ? (
                <>Are you sure you want to delete <strong className="text-foreground">{confirmTarget?.name}</strong>? This cannot be undone.</>
              ) : (
                <>Deactivate <strong className="text-foreground">{confirmTarget?.name}</strong>? It won&apos;t appear in new create dropdowns, but existing tickets keep showing it. You can reactivate it later.</>
              )}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={confirming}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirm} disabled={confirming}>
              {confirming && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {confirmKind === "delete" ? "Delete" : "Deactivate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
