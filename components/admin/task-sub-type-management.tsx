"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Search, Plus, Loader2, Pencil, Trash2, Wrench } from "lucide-react";
import { formatEUR } from "@/lib/currency";

interface TypeRow {
  id: string;
  name: string;
  isActive: boolean;
  // null means "no fixed configured cost" (e.g. "Others"/"External") —
  // never coerced to/from 0 anywhere in this component.
  cost: number | null;
  _count: { activities: number };
}

interface TaskSubTypeManagementProps {
  types: TypeRow[];
}

// Task Sub Type (formerly "Activity Task Type"/"Task Type" — see
// TaskSubType in prisma/schema.prisma) management — identity/name +
// lifecycle + OPTIONAL cost. An empty cost field means "leave it with no
// fixed cost," never a validation error and never defaulted to 0.
export function TaskSubTypeManagement({ types: initialTypes }: TaskSubTypeManagementProps) {
  const router = useRouter();
  const [types, setTypes] = useState(initialTypes);
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCost, setCreateCost] = useState("");

  const [editTarget, setEditTarget] = useState<TypeRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editCost, setEditCost] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<TypeRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = types.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()));

  // Blank is a VALID input now (-> null, "no fixed cost"). Only a
  // non-blank value is checked for being a real, non-negative number —
  // mirrors taskSubTypeSchema's own client-side-reachable checks (the
  // server independently re-validates regardless; this is purely for
  // disabling the submit button on obviously invalid input).
  const isValidCost = (raw: string) => {
    if (raw.trim() === "") return true;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0;
  };
  // undefined -> key omitted from the request body entirely (PATCH only;
  // POST always sends the key, blank -> null).
  const costToSend = (raw: string): number | null => (raw.trim() === "" ? null : Number(raw));

  const handleCreate = async () => {
    if (!createName.trim() || !isValidCost(createCost)) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/task-sub-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, cost: costToSend(createCost) }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to create Task Sub Type");
      }
      const created = await res.json();
      setTypes((prev) => [...prev, created]);
      toast.success("Task Sub Type created");
      setCreateOpen(false);
      setCreateName("");
      setCreateCost("");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create Task Sub Type");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (type: TypeRow) => {
    setEditTarget(type);
    setEditName(type.name);
    setEditCost(type.cost === null ? "" : String(type.cost));
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editName.trim() || !isValidCost(editCost)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/task-sub-types/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, cost: costToSend(editCost) }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update Task Sub Type");
      }
      const updated = await res.json();
      setTypes((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
      toast.success("Task Sub Type updated");
      setEditTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update Task Sub Type");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (type: TypeRow) => {
    try {
      const res = await fetch(`/api/admin/task-sub-types/${type.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !type.isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update Task Sub Type");
      }
      const updated = await res.json();
      setTypes((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
      toast.success(updated.isActive ? "Activated" : "Deactivated");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update Task Sub Type");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/task-sub-types/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to delete Task Sub Type");
      }
      setTypes((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      toast.success("Task Sub Type deleted");
      setDeleteTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete Task Sub Type");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search Task Sub Types..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">{filtered.length} types</span>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          Add Task Sub Type
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Name</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Activities</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-28"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-10">
                  No Task Sub Types match your search.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((type) => (
              <TableRow key={type.id} className={type.isActive ? undefined : "opacity-50"}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 shrink-0">
                      <Wrench className="h-4 w-4 text-indigo-600" />
                    </div>
                    <span className="text-sm font-medium">{type.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {type.cost === null ? <span className="text-muted-foreground">No fixed cost</span> : formatEUR(type.cost)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{type._count.activities}</TableCell>
                <TableCell>
                  <button
                    onClick={() => toggleActive(type)}
                    className={`text-xs font-medium ${type.isActive ? "text-green-700" : "text-muted-foreground"}`}
                  >
                    {type.isActive ? "Active" : "Inactive"}
                  </button>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(type)} aria-label={`Edit ${type.name}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(type)} aria-label={`Delete ${type.name}`}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) { setCreateName(""); setCreateCost(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Task Sub Type</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="e.g. Development" value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-tasksubtype-cost">Cost (EUR)</Label>
              <p className="text-xs text-muted-foreground">
                Optional — leave blank for Task Sub Types with no fixed predefined cost (e.g. &quot;Others&quot;, &quot;External&quot;).
              </p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                <Input
                  id="create-tasksubtype-cost"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="No fixed cost"
                  className="pl-7"
                  value={createCost}
                  onChange={(e) => setCreateCost(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); setCreateName(""); setCreateCost(""); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim() || !isValidCost(createCost)}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Task Sub Type
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Task Sub Type</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-tasksubtype-cost">Cost (EUR)</Label>
              <p className="text-xs text-muted-foreground">
                Optional — clear it for no fixed cost. Changing this does NOT affect Activities already created with this Task Sub
                Type — they keep their own historical cost snapshot.
              </p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                <Input
                  id="edit-tasksubtype-cost"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="No fixed cost"
                  className="pl-7"
                  value={editCost}
                  onChange={(e) => setEditCost(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editName.trim() || !isValidCost(editCost)}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Task Sub Type</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This cannot be undone. If it's still
                  used by any Activity, deletion will be blocked until you deactivate it instead.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
