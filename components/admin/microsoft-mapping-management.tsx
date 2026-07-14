"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DepartmentRole, MicrosoftMappingSourceType } from "@prisma/client";
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
import { Switch } from "@/components/ui/switch";
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
import { Plus, Loader2, Trash2 } from "lucide-react";
import {
  DEPARTMENT_ROLE_LABELS,
  DEPARTMENT_ROLE_DESCRIPTIONS,
  DEPARTMENT_ROLE_OPTIONS,
  MAPPING_SOURCE_TYPE_LABELS,
  MAPPING_SOURCE_TYPE_HELP,
  MAPPING_SOURCE_TYPE_OPTIONS,
} from "@/components/admin/department-role-info";

interface Mapping {
  id: string;
  sourceType: MicrosoftMappingSourceType;
  microsoftValue: string;
  departmentId: string;
  role: DepartmentRole;
  isActive: boolean;
  department: { id: string; name: string; slug: string };
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface MicrosoftMappingManagementProps {
  mappings: Mapping[];
  departments: DepartmentOption[];
}

export function MicrosoftMappingManagement({ mappings: initialMappings, departments }: MicrosoftMappingManagementProps) {
  const [mappings, setMappings] = useState(initialMappings);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sourceType, setSourceType] = useState<MicrosoftMappingSourceType>(MicrosoftMappingSourceType.ENTRA_GROUP);
  const [value, setValue] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [role, setRole] = useState<DepartmentRole>(DepartmentRole.REQUESTER);

  const resetCreate = () => {
    setSourceType(MicrosoftMappingSourceType.ENTRA_GROUP);
    setValue("");
    setDepartmentId(departments[0]?.id ?? "");
    setRole(DepartmentRole.REQUESTER);
  };

  const handleCreate = async () => {
    if (!value.trim() || !departmentId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/microsoft-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceType, microsoftValue: value.trim(), departmentId, role }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create mapping");
      }
      const created = await res.json();
      const dept = departments.find((d) => d.id === departmentId);
      setMappings((prev) => [...prev, { ...created, department: { id: departmentId, name: dept?.name ?? "", slug: "" } }]);
      toast.success("Mapping created");
      setCreateOpen(false);
      resetCreate();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create mapping");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (mapping: Mapping) => {
    setBusyId(mapping.id);
    try {
      const res = await fetch(`/api/admin/microsoft-mappings/${mapping.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !mapping.isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update mapping");
      }
      setMappings((prev) => prev.map((m) => (m.id === mapping.id ? { ...m, isActive: !m.isActive } : m)));
      toast.success(mapping.isActive ? "Mapping deactivated" : "Mapping activated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update mapping");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (mapping: Mapping) => {
    setBusyId(mapping.id);
    try {
      const res = await fetch(`/api/admin/microsoft-mappings/${mapping.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to delete mapping");
      }
      setMappings((prev) => prev.filter((m) => m.id !== mapping.id));
      toast.success("Mapping deleted");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete mapping");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {mappings.length} mapping{mappings.length !== 1 ? "s" : ""} — inactive mappings are ignored by login sync.
        </p>
        <Button onClick={() => setCreateOpen(true)} size="sm" disabled={departments.length === 0}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add Mapping
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Source Type</TableHead>
              <TableHead>Microsoft Value</TableHead>
              <TableHead>Maps To</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mappings.map((m) => (
              <TableRow key={m.id} className={!m.isActive ? "opacity-60" : undefined}>
                <TableCell>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                    {MAPPING_SOURCE_TYPE_LABELS[m.sourceType]}
                  </span>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{m.microsoftValue}</code>
                </TableCell>
                <TableCell>
                  <span className="text-sm">
                    {m.department.name} <span className="text-muted-foreground">— {DEPARTMENT_ROLE_LABELS[m.role]}</span>
                  </span>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={m.isActive}
                    onCheckedChange={() => handleToggleActive(m)}
                    disabled={busyId === m.id}
                  />
                </TableCell>
                <TableCell>
                  {busyId === m.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10"
                      onClick={() => handleDelete(m)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {mappings.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  No Microsoft mappings yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Microsoft Mapping</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Source Type</Label>
              <Select value={sourceType} onValueChange={(v) => setSourceType(v as MicrosoftMappingSourceType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MAPPING_SOURCE_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>{MAPPING_SOURCE_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{MAPPING_SOURCE_TYPE_HELP[sourceType]}</p>
            </div>

            <div className="space-y-2">
              <Label>Microsoft Value</Label>
              <Input
                placeholder='e.g. "TicketApp - Procurement"'
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId}>
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Role granted</Label>
              <Select value={role} onValueChange={(v) => setRole(v as DepartmentRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEPARTMENT_ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>{DEPARTMENT_ROLE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{DEPARTMENT_ROLE_DESCRIPTIONS[role]}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !value.trim() || !departmentId}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Mapping
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
