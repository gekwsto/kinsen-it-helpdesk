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
import { Search, Plus, Loader2, Pencil, Trash2, Receipt } from "lucide-react";

interface TypeRow {
  id: string;
  name: string;
  isActive: boolean;
  _count: { projects: number };
}

interface ProjectExpenseTypeManagementProps {
  types: TypeRow[];
}

export function ProjectExpenseTypeManagement({ types: initialTypes }: ProjectExpenseTypeManagementProps) {
  const router = useRouter();
  const [types, setTypes] = useState(initialTypes);
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");

  const [editTarget, setEditTarget] = useState<TypeRow | null>(null);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<TypeRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = types.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()));

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/project-expense-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to create type");
      }
      const created = await res.json();
      setTypes((prev) => [...prev, created]);
      toast.success("Project Expense Type created");
      setCreateOpen(false);
      setCreateName("");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create type");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (type: TypeRow) => {
    setEditTarget(type);
    setEditName(type.name);
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/project-expense-types/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update type");
      }
      const updated = await res.json();
      setTypes((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
      toast.success("Project Expense Type updated");
      setEditTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update type");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (type: TypeRow) => {
    try {
      const res = await fetch(`/api/admin/project-expense-types/${type.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !type.isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update type");
      }
      const updated = await res.json();
      setTypes((prev) => prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)));
      toast.success(updated.isActive ? "Activated" : "Deactivated");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update type");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/project-expense-types/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to delete type");
      }
      setTypes((prev) => prev.filter((t) => t.id !== deleteTarget.id));
      toast.success("Project Expense Type deleted");
      setDeleteTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete type");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search types..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">{filtered.length} types</span>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          Add Type
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Name</TableHead>
              <TableHead>Projects</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-28"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-10">
                  No Project Expense Types match your search.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((type) => (
              <TableRow key={type.id} className={type.isActive ? undefined : "opacity-50"}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50 shrink-0">
                      <Receipt className="h-4 w-4 text-amber-600" />
                    </div>
                    <span className="text-sm font-medium">{type.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{type._count.projects}</TableCell>
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

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) setCreateName(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Project Expense Type</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="e.g. CapEx" value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); setCreateName(""); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Type
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project Expense Type</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editName.trim()}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project Expense Type</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This cannot be undone. If it's still
                  used by any Project, deletion will be blocked until you deactivate it instead.
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
