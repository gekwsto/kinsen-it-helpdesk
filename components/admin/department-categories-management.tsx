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
import { Plus, Loader2, Ban, ShieldCheck } from "lucide-react";

interface Category {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isActive: boolean;
  departmentId: string | null;
  _count: { tickets: number };
}

interface DepartmentCategoriesManagementProps {
  departmentId: string;
  categories: Category[];
}

export function DepartmentCategoriesManagement({ departmentId, categories: initialCategories }: DepartmentCategoriesManagementProps) {
  const [categories, setCategories] = useState(initialCategories);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#6366f1");

  const resetCreate = () => {
    setName("");
    setDescription("");
    setColor("#6366f1");
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description.trim() || undefined, color, departmentId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create category");
      }
      const created = await res.json();
      setCategories((prev) => [...prev, { ...created, _count: { tickets: 0 } }].sort((a, b) => a.name.localeCompare(b.name)));
      toast.success("Category created");
      setCreateOpen(false);
      resetCreate();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create category");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (category: Category) => {
    setBusyId(category.id);
    try {
      if (category.isActive) {
        const res = await fetch(`/api/admin/categories?id=${category.id}`, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Failed to deactivate category");
        }
      } else {
        const res = await fetch("/api/admin/categories", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: category.id, isActive: true }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Failed to activate category");
        }
      }
      setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, isActive: !c.isActive } : c)));
      toast.success(category.isActive ? "Category deactivated" : "Category activated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update category");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {categories.length} categor{categories.length !== 1 ? "ies" : "y"} (this department + global)
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          Add Category
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Category</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Tickets</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {categories.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                    <div>
                      <p className="text-sm font-medium">{c.name}</p>
                      {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                      c.departmentId
                        ? "bg-blue-50 text-blue-700 border-blue-200"
                        : "bg-slate-100 text-slate-600 border-slate-200"
                    }`}
                  >
                    {c.departmentId ? "This department" : "Global"}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{c._count.tickets}</span>
                </TableCell>
                <TableCell>
                  <span className={`text-xs font-medium ${c.isActive ? "text-green-700" : "text-muted-foreground"}`}>
                    {c.isActive ? "Active" : "Inactive"}
                  </span>
                </TableCell>
                <TableCell>
                  {busyId === c.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      title={c.isActive ? "Deactivate" : "Activate"}
                      onClick={() => handleToggleActive(c)}
                      className={c.isActive ? "text-orange-500 hover:text-orange-600 hover:bg-orange-50" : "text-green-600 hover:text-green-700 hover:bg-green-50"}
                    >
                      {c.isActive ? <Ban className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {categories.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  No categories yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Category</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="Supplier" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <Input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-10 w-20 p-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Category
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
