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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Plus, Loader2, Pencil, Trash2, Network } from "lucide-react";

interface BusinessUnitRow {
  id: string;
  name: string;
  companyId: string;
  company: { id: string; name: string };
  _count: { departments: number; users: number; projects: number; activities: number };
}

interface CompanyOption {
  id: string;
  name: string;
}

interface BusinessUnitManagementProps {
  businessUnits: BusinessUnitRow[];
  companies: CompanyOption[];
}

export function BusinessUnitManagement({ businessUnits: initialBusinessUnits, companies }: BusinessUnitManagementProps) {
  const router = useRouter();
  const [businessUnits, setBusinessUnits] = useState(initialBusinessUnits);
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCompanyId, setCreateCompanyId] = useState("");

  const [editTarget, setEditTarget] = useState<BusinessUnitRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editCompanyId, setEditCompanyId] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<BusinessUnitRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = businessUnits.filter(
    (bu) =>
      bu.name.toLowerCase().includes(search.toLowerCase()) ||
      bu.company.name.toLowerCase().includes(search.toLowerCase())
  );

  const resetCreate = () => {
    setCreateName("");
    setCreateCompanyId("");
  };

  const handleCreate = async () => {
    if (!createName.trim() || !createCompanyId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/business-units", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: createName, companyId: createCompanyId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to create business unit");
      }
      const created = await res.json();
      setBusinessUnits((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      toast.success("Business unit created");
      setCreateOpen(false);
      resetCreate();
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create business unit");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (businessUnit: BusinessUnitRow) => {
    setEditTarget(businessUnit);
    setEditName(businessUnit.name);
    setEditCompanyId(businessUnit.companyId);
  };

  const handleSaveEdit = async () => {
    if (!editTarget || !editName.trim() || !editCompanyId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/business-units/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, companyId: editCompanyId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to update business unit");
      }
      const updated = await res.json();
      setBusinessUnits((prev) => prev.map((bu) => (bu.id === updated.id ? updated : bu)));
      toast.success("Business unit updated");
      setEditTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update business unit");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/business-units/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? err.error ?? "Failed to delete business unit");
      }
      setBusinessUnits((prev) => prev.filter((bu) => bu.id !== deleteTarget.id));
      toast.success("Business unit deleted");
      setDeleteTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete business unit");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search business units..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">{filtered.length} business units</span>
        <Button onClick={() => setCreateOpen(true)} size="sm" disabled={companies.length === 0}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Business Unit
        </Button>
      </div>

      {companies.length === 0 && (
        <p className="text-sm text-muted-foreground">Create a company first before adding business units.</p>
      )}

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Business Unit</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Departments</TableHead>
              <TableHead>Users</TableHead>
              <TableHead>Projects</TableHead>
              <TableHead>Activities</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-10">
                  No business units match your search.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((bu) => (
              <TableRow key={bu.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-50 shrink-0">
                      <Network className="h-4 w-4 text-purple-600" />
                    </div>
                    <span className="text-sm font-medium">{bu.name}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{bu.company.name}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{bu._count.departments}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{bu._count.users}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{bu._count.projects}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{bu._count.activities}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(bu)} aria-label={`Edit ${bu.name}`}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(bu)} aria-label={`Delete ${bu.name}`}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Business Unit</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="Information Technology" value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={createCompanyId} onValueChange={setCreateCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim() || !createCompanyId}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Business Unit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Business Unit</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={editCompanyId} onValueChange={setEditCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editName.trim() || !editCompanyId}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Business Unit</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  Are you sure you want to delete <strong>{deleteTarget.name}</strong>? This cannot be undone. If it still has
                  departments, users, projects, or activities, deletion will be blocked until you move or remove them first.
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
