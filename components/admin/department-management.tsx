"use client";

import { useState } from "react";
import Link from "next/link";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, Plus, Loader2, ArrowUpRight, Building2 } from "lucide-react";

interface DepartmentRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  businessUnit: { id: string; name: string } | null;
  _count: { users: number; tickets: number };
}

interface DepartmentManagementProps {
  departments: DepartmentRow[];
}

export function DepartmentManagement({ departments: initialDepartments }: DepartmentManagementProps) {
  const router = useRouter();
  const [departments, setDepartments] = useState(initialDepartments);
  const [search, setSearch] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");

  const filtered = departments.filter(
    (d) =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.slug.toLowerCase().includes(search.toLowerCase())
  );

  const resetCreate = () => {
    setCreateName("");
    setCreateDescription("");
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName,
          description: createDescription.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create department");
      }
      const created = await res.json();
      setDepartments((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      toast.success("Department created");
      setCreateOpen(false);
      resetCreate();
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create department");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (department: DepartmentRow) => {
    setTogglingId(department.id);
    try {
      const res = await fetch(`/api/admin/departments/${department.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !department.isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update department");
      }
      const updated = await res.json();
      setDepartments((prev) => prev.map((d) => (d.id === department.id ? { ...d, ...updated } : d)));
      toast.success(department.isActive ? "Department deactivated" : "Department activated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update department");
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search departments..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground">{filtered.length} departments</span>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          Add Department
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Department</TableHead>
              <TableHead>Business Unit</TableHead>
              <TableHead>Users</TableHead>
              <TableHead>Tickets</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((department) => (
              <TableRow key={department.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 shrink-0">
                      <Building2 className="h-4 w-4 text-blue-600" />
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/admin/departments/${department.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {department.name}
                      </Link>
                      <p className="text-xs text-muted-foreground truncate">{department.slug}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{department.businessUnit?.name ?? "—"}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{department._count.users}</span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{department._count.tickets}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={department.isActive}
                      onCheckedChange={() => handleToggleActive(department)}
                      disabled={togglingId === department.id}
                    />
                    <span className={`text-xs font-medium ${department.isActive ? "text-green-700" : "text-muted-foreground"}`}>
                      {togglingId === department.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : department.isActive ? (
                        "Active"
                      ) : (
                        "Inactive"
                      )}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/admin/departments/${department.id}`}>
                      <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Department</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="Procurement" value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea
                placeholder="Purchasing, vendor management and supplier relations"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Department
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
