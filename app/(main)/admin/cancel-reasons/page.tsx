"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, Pencil, Trash2, ToggleLeft, ToggleRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CancelReason {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  _count: { tickets: number };
}

export default function CancelReasonsAdminPage() {
  const [reasons, setReasons] = useState<CancelReason[]>([]);
  const [loading, setLoading] = useState(true);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");

  // Edit dialog
  const [editTarget, setEditTarget] = useState<CancelReason | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<CancelReason | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Toggling active state
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/cancel-reasons")
      .then((r) => r.json())
      .then((data) => setReasons(data))
      .catch(() => toast.error("Failed to load cancel reasons"))
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/cancel-reasons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, description: createDesc || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to create");
      }
      const created = await res.json();
      setReasons((prev) => [...prev, { ...created, _count: { tickets: 0 } }].sort((a, b) => a.name.localeCompare(b.name)));
      setCreateOpen(false);
      setCreateName("");
      setCreateDesc("");
      toast.success("Cancel reason created");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (reason: CancelReason) => {
    setEditTarget(reason);
    setEditName(reason.name);
    setEditDesc(reason.description ?? "");
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editTarget || !editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/cancel-reasons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editTarget.id, name: editName, description: editDesc || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update");
      }
      const updated = await res.json();
      setReasons((prev) => prev.map((r) => (r.id === updated.id ? { ...updated, _count: r._count } : r)));
      setEditOpen(false);
      toast.success("Cancel reason updated");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (reason: CancelReason) => {
    setToggling(reason.id);
    try {
      const res = await fetch("/api/admin/cancel-reasons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reason.id, isActive: !reason.isActive }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setReasons((prev) => prev.map((r) => (r.id === updated.id ? { ...updated, _count: r._count } : r)));
      toast.success(updated.isActive ? "Cancel reason activated" : "Cancel reason deactivated");
    } catch {
      toast.error("Failed to update status");
    } finally {
      setToggling(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/cancel-reasons?id=${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error ?? "Failed to delete");
        if (res.status === 409) return;
        return;
      }
      setReasons((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      setDeleteOpen(false);
      setDeleteTarget(null);
      toast.success("Cancel reason deleted");
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cancel Reasons</h1>
          <p className="text-muted-foreground mt-1">Manage reasons available when cancelling a ticket</p>
        </div>
        <Button onClick={() => { setCreateName(""); setCreateDesc(""); setCreateOpen(true); }}>
          <Plus className="h-4 w-4 mr-2" />
          Add Cancel Reason
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-20">Tickets</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-28">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reasons.map((reason) => (
                <TableRow key={reason.id} className={cn(!reason.isActive && "opacity-50")}>
                  <TableCell className="font-medium">{reason.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{reason.description ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{reason._count.tickets}</TableCell>
                  <TableCell>
                    <span className={cn(
                      "text-xs px-2 py-0.5 rounded-full font-medium",
                      reason.isActive
                        ? "bg-green-100 text-green-700"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {reason.isActive ? "Active" : "Inactive"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(reason)} title="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleToggle(reason)}
                        disabled={toggling === reason.id}
                        title={reason.isActive ? "Deactivate" : "Activate"}
                        className={reason.isActive ? "text-muted-foreground" : "text-green-600"}
                      >
                        {toggling === reason.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : reason.isActive ? (
                          <ToggleRight className="h-3.5 w-3.5" />
                        ) : (
                          <ToggleLeft className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => { setDeleteTarget(reason); setDeleteOpen(true); }}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {reasons.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                    No cancel reasons yet. Add one to allow cancelling tickets.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Cancel Reason</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="create-name">Name *</Label>
              <Input
                id="create-name"
                placeholder="e.g. Duplicate"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-desc">Description</Label>
              <Textarea
                id="create-desc"
                placeholder="Optional explanation"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Cancel Reason</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name *</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea
                id="edit-desc"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving || !editName.trim()}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={(o) => { setDeleteOpen(o); if (!o) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Cancel Reason</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete{" "}
              <strong className="text-foreground">{deleteTarget?.name}</strong>?
            </p>
            {deleteTarget && deleteTarget._count.tickets > 0 && (
              <p className="text-sm text-destructive font-medium">
                This reason is used by {deleteTarget._count.tickets} ticket{deleteTarget._count.tickets > 1 ? "s" : ""}.
                Deletion will be blocked — deactivate it instead.
              </p>
            )}
            {deleteTarget && deleteTarget._count.tickets === 0 && (
              <p className="text-sm text-muted-foreground">
                This reason is not used by any tickets and will be permanently removed.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
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
