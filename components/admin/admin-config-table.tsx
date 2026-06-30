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
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react";

interface ConfigItem {
  id: string;
  name: string;
  description?: string | null;
  color?: string;
  isActive?: boolean;
  [key: string]: any;
}

interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "color" | "number";
  required?: boolean;
}

type ExtraColumn =
  | { type: "field"; header: string; field: string }
  | {
      type: "badges";
      header: string;
      badges: Array<{ field: string; label: string; className: string }>;
    };

function getNestedValue(obj: ConfigItem, path: string): unknown {
  return path.split(".").reduce((acc: any, key) => acc?.[key], obj);
}

function renderExtraColumn(col: ExtraColumn, item: ConfigItem): React.ReactNode {
  if (col.type === "field") {
    const value = getNestedValue(item, col.field);
    return (
      <span className="text-sm text-muted-foreground">
        {value != null ? String(value) : "—"}
      </span>
    );
  }
  if (col.type === "badges") {
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
  return null;
}

interface AdminConfigTableProps {
  title: string;
  items: ConfigItem[];
  fields: Field[];
  apiEndpoint: string;
  extraColumns?: ExtraColumn[];
}

export function AdminConfigTable({
  title,
  items: initialItems,
  fields,
  apiEndpoint,
  extraColumns = [],
}: AdminConfigTableProps) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<ConfigItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});

  const openCreate = () => {
    setForm(Object.fromEntries(fields.map((f) => [f.key, f.type === "color" ? "#6366f1" : ""])));
    setCreateOpen(true);
  };

  const openEdit = (item: ConfigItem) => {
    setEditItem(item);
    setForm(Object.fromEntries(fields.map((f) => [f.key, item[f.key] ?? ""])));
    setEditOpen(true);
  };

  const handleCreate = async () => {
    setSaving(true);
    try {
      const res = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create");
      }
      const created = await res.json();
      setItems((prev) => [...prev, created]);
      toast.success(`${title} created`);
      setCreateOpen(false);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create");
    } finally {
      setSaving(false);
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
      if (!res.ok) throw new Error("Failed to update");
      const updated = await res.json();
      setItems((prev) => prev.map((i) => (i.id === editItem.id ? updated : i)));
      toast.success(`${title} updated`);
      setEditOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch(`${apiEndpoint}?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      setItems((prev) => prev.filter((i) => i.id !== id));
      toast.success(`${title} removed`);
      router.refresh();
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(null);
    }
  };

  const FormFields = () => (
    <div className="space-y-4 py-2">
      {fields.map((field) => (
        <div key={field.key} className="space-y-2">
          <Label htmlFor={field.key}>
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </Label>
          {field.type === "textarea" ? (
            <Textarea
              id={field.key}
              value={form[field.key] ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.value }))}
            />
          ) : field.type === "color" ? (
            <div className="flex items-center gap-3">
              <input
                type="color"
                id={field.key}
                value={form[field.key] ?? "#6366f1"}
                onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.value }))}
                className="h-10 w-16 cursor-pointer rounded border"
              />
              <Input
                value={form[field.key] ?? ""}
                onChange={(e) => setForm((p) => ({ ...p, [field.key]: e.target.value }))}
                className="font-mono"
                placeholder="#6366f1"
              />
            </div>
          ) : (
            <Input
              id={field.key}
              type={field.type}
              value={form[field.key] ?? ""}
              onChange={(e) => setForm((p) => ({ ...p, [field.key]: field.type === "number" ? parseInt(e.target.value) : e.target.value }))}
            />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{items.length} items</span>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-2" />
              Add {title}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create {title}</DialogTitle>
            </DialogHeader>
            <FormFields />
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Name</TableHead>
              {fields.some((f) => f.key === "color") && (
                <TableHead className="w-24">Color</TableHead>
              )}
              {extraColumns.map((c) => (
                <TableHead key={c.header}>{c.header}</TableHead>
              ))}
              {fields.some((f) => f.key === "description") && (
                <TableHead>Description</TableHead>
              )}
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id} className={!item.isActive ? "opacity-50" : ""}>
                <TableCell className="font-medium">{item.name}</TableCell>
                {fields.some((f) => f.key === "color") && (
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className="h-5 w-5 rounded-full border"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-xs font-mono text-muted-foreground">
                        {item.color}
                      </span>
                    </div>
                  </TableCell>
                )}
                {extraColumns.map((c) => (
                  <TableCell key={c.header}>{renderExtraColumn(c, item)}</TableCell>
                ))}
                {fields.some((f) => f.key === "description") && (
                  <TableCell className="text-muted-foreground text-sm">
                    {item.description ?? "—"}
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(item)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(item.id)}
                      disabled={deleting === item.id}
                    >
                      {deleting === item.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4 + extraColumns.length}
                  className="text-center text-muted-foreground py-8"
                >
                  No items yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {title}</DialogTitle>
          </DialogHeader>
          <FormFields />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
