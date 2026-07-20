"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { Label } from "@/components/ui/label";
import { Plus, Loader2, Pencil, Trash2, Users, Ban, ShieldCheck } from "lucide-react";

interface SubDepartment {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  departmentId: string;
  /** Present only in cross-department mode (departments prop given). */
  department?: { id: string; name: string };
  _count?: { memberships: number; tickets: number; projects: number; activities: number };
}

interface SubDepartmentManagementProps {
  subDepartments: SubDepartment[];
  /** Render the Users/Tickets/Projects/Activities count columns. */
  showCounts?: boolean;

  // ── Fixed single-department mode (nested /admin/departments/[id]/sub-departments) ──
  departmentId?: string;
  canCreate?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;

  // ── Cross-department mode (/admin/sub-departments, /my-subdepartments) ──
  // Passing `departments` switches the table into cross-department mode: a
  // Department column appears, the create dialog gets a department picker,
  // and per-row edit/disable/delete controls check the OWNING department's
  // membership in the *DepartmentIds sets below instead of one blanket
  // boolean — a caller can have create/update/delete in some accessible
  // departments but not others.
  departments?: { id: string; name: string }[];
  createDepartmentIds?: string[];
  updateDepartmentIds?: string[];
  deleteDepartmentIds?: string[];
}

export function SubDepartmentManagement({
  subDepartments: initial,
  showCounts = false,
  departmentId,
  canCreate,
  canUpdate,
  canDelete,
  departments,
  createDepartmentIds,
  updateDepartmentIds,
  deleteDepartmentIds,
}: SubDepartmentManagementProps) {
  const router = useRouter();
  const [subDepartments, setSubDepartments] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);

  const isGlobalMode = !!departments;
  const createOptions = isGlobalMode
    ? (departments ?? []).filter((d) => (createDepartmentIds ?? []).includes(d.id))
    : [];
  const canCreateAny = isGlobalMode ? createOptions.length > 0 : !!canCreate;
  const rowCanUpdate = (sd: SubDepartment) =>
    isGlobalMode ? (updateDepartmentIds ?? []).includes(sd.departmentId) : !!canUpdate;
  const rowCanDelete = (sd: SubDepartment) =>
    isGlobalMode ? (deleteDepartmentIds ?? []).includes(sd.departmentId) : !!canDelete;

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createDeptId, setCreateDeptId] = useState("");

  const [editTarget, setEditTarget] = useState<SubDepartment | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<SubDepartment | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const resetCreate = () => {
    setCreateName("");
    setCreateDesc("");
    setCreateDeptId("");
  };

  const handleCreate = async () => {
    const targetDeptId = isGlobalMode ? createDeptId : departmentId;
    if (!createName.trim() || !targetDeptId) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/admin/departments/${targetDeptId}/sub-departments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, description: createDesc || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create sub-department");
      }
      const created = await res.json();
      const deptInfo = isGlobalMode ? departments?.find((d) => d.id === targetDeptId) : undefined;
      setSubDepartments((prev) =>
        [...prev, deptInfo ? { ...created, department: deptInfo } : created].sort((a, b) => a.name.localeCompare(b.name))
      );
      setCreateOpen(false);
      resetCreate();
      toast.success("Sub-department created");
      router.refresh();
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create sub-department");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (sd: SubDepartment) => {
    setEditTarget(sd);
    setEditName(sd.name);
    setEditDesc(sd.description ?? "");
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editTarget || !editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/departments/${editTarget.departmentId}/sub-departments/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, description: editDesc || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update sub-department");
      }
      const updated = await res.json();
      setSubDepartments((prev) => prev.map((sd) => (sd.id === updated.id ? { ...sd, ...updated } : sd)));
      setEditOpen(false);
      toast.success("Sub-department updated");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update sub-department");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (sd: SubDepartment) => {
    setBusyId(sd.id);
    try {
      const res = await fetch(`/api/admin/departments/${sd.departmentId}/sub-departments/${sd.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !sd.isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update sub-department");
      }
      const updated = await res.json();
      setSubDepartments((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
      toast.success(updated.isActive ? "Sub-department enabled" : "Sub-department disabled");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update sub-department");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/departments/${deleteTarget.departmentId}/sub-departments/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error ?? "Failed to delete sub-department");
        return;
      }
      setSubDepartments((prev) => prev.filter((sd) => sd.id !== deleteTarget.id));
      setDeleteOpen(false);
      setDeleteTarget(null);
      toast.success("Sub-department deleted");
    } catch {
      toast.error("Failed to delete sub-department");
    } finally {
      setDeleting(false);
    }
  };

  const columnCount = 3 + (isGlobalMode ? 1 : 0) + (showCounts ? 4 : 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {subDepartments.length} sub-department{subDepartments.length !== 1 ? "s" : ""}
        </p>
        {canCreateAny && (
          <Button onClick={() => setCreateOpen(true)} size="sm">
            <Plus className="h-4 w-4 mr-1.5" />
            Add Sub-Department
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Sub Department</TableHead>
              {isGlobalMode && <TableHead>Parent Department</TableHead>}
              {showCounts && (
                <>
                  <TableHead className="text-center">Users</TableHead>
                  <TableHead className="text-center">Tickets</TableHead>
                  <TableHead className="text-center">Projects</TableHead>
                  <TableHead className="text-center">Activities</TableHead>
                </>
              )}
              <TableHead>Status</TableHead>
              <TableHead className="w-48"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {subDepartments.map((sd) => (
              <TableRow key={sd.id} className={!sd.isActive ? "opacity-60" : undefined}>
                <TableCell>
                  <div className="font-medium text-sm">{sd.name}</div>
                  {sd.description && <div className="text-xs text-muted-foreground">{sd.description}</div>}
                </TableCell>
                {isGlobalMode && (
                  <TableCell className="text-sm text-muted-foreground">{sd.department?.name ?? "—"}</TableCell>
                )}
                {showCounts && (
                  <>
                    <TableCell className="text-center text-sm">{sd._count?.memberships ?? 0}</TableCell>
                    <TableCell className="text-center text-sm">{sd._count?.tickets ?? 0}</TableCell>
                    <TableCell className="text-center text-sm">{sd._count?.projects ?? 0}</TableCell>
                    <TableCell className="text-center text-sm">{sd._count?.activities ?? 0}</TableCell>
                  </>
                )}
                <TableCell>
                  {sd.isActive ? (
                    <span className="text-xs text-green-700">Active</span>
                  ) : (
                    <span className="text-xs text-red-600">Disabled</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-0.5 justify-end">
                    <Button size="sm" variant="ghost" asChild title="Members">
                      <Link href={`/admin/departments/${sd.departmentId}/sub-departments/${sd.id}/members`}>
                        <Users className="h-3.5 w-3.5" />
                      </Link>
                    </Button>
                    {rowCanUpdate(sd) && (
                      <Button size="sm" variant="ghost" onClick={() => openEdit(sd)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {rowCanUpdate(sd) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === sd.id}
                        className={sd.isActive ? "text-orange-500 hover:text-orange-600 hover:bg-orange-50" : "text-green-600 hover:text-green-700 hover:bg-green-50"}
                        onClick={() => handleToggleActive(sd)}
                        title={sd.isActive ? "Disable" : "Enable"}
                      >
                        {busyId === sd.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sd.isActive ? <Ban className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      </Button>
                    )}
                    {rowCanDelete(sd) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => { setDeleteTarget(sd); setDeleteOpen(true); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {subDepartments.length === 0 && (
              <TableRow>
                <TableCell colSpan={columnCount} className="text-center text-sm text-muted-foreground py-8">
                  No sub-departments found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Sub-Department</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {isGlobalMode && (
              <div className="space-y-2">
                <Label htmlFor="create-dept">Department *</Label>
                <Select value={createDeptId} onValueChange={setCreateDeptId}>
                  <SelectTrigger id="create-dept">
                    <SelectValue placeholder="Select department…" />
                  </SelectTrigger>
                  <SelectContent>
                    {createOptions.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="create-name">Name *</Label>
              <Input id="create-name" placeholder="e.g. Network Support" value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-desc">Description</Label>
              <Textarea id="create-desc" value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !createName.trim() || (isGlobalMode && !createDeptId)}
            >
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Sub-Department</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name *</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea id="edit-desc" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving || !editName.trim()}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Sub-Department</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This only succeeds if nothing
              is linked to it yet — otherwise, disable it instead.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
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
