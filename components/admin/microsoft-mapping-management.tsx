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
import { Plus, Loader2, Trash2, Pencil, RefreshCw } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
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
  directoryValues: string[];
  directoryLastSyncedAt: string | null;
}

export function MicrosoftMappingManagement({
  mappings: initialMappings,
  departments,
  directoryValues: initialDirectoryValues,
  directoryLastSyncedAt: initialLastSyncedAt,
}: MicrosoftMappingManagementProps) {
  const [mappings, setMappings] = useState(initialMappings);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [directoryValues, setDirectoryValues] = useState(initialDirectoryValues);
  const [directoryLastSyncedAt, setDirectoryLastSyncedAt] = useState(initialLastSyncedAt);
  const [syncing, setSyncing] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<Mapping | null>(null);
  const [saving, setSaving] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [sourceType, setSourceType] = useState<MicrosoftMappingSourceType>(MicrosoftMappingSourceType.ENTRA_GROUP);
  const [value, setValue] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [role, setRole] = useState<DepartmentRole>(DepartmentRole.REQUESTER);

  const resetForm = () => {
    setEditingMapping(null);
    setSourceType(MicrosoftMappingSourceType.ENTRA_GROUP);
    setValue("");
    setDepartmentId(departments[0]?.id ?? "");
    setRole(DepartmentRole.REQUESTER);
    setManualEntry(false);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (mapping: Mapping) => {
    setEditingMapping(mapping);
    setSourceType(mapping.sourceType);
    setValue(mapping.microsoftValue);
    setDepartmentId(mapping.departmentId);
    setRole(mapping.role);
    // If the mapping's current value isn't in the cached directory list,
    // default to manual entry so the admin sees the real stored value
    // instead of an empty/mismatched dropdown.
    setManualEntry(
      mapping.sourceType === MicrosoftMappingSourceType.PROFILE_DEPARTMENT &&
        !directoryValues.includes(mapping.microsoftValue)
    );
    setDialogOpen(true);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/microsoft-directory/departments/sync", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Sync failed");
      }
      const listRes = await fetch("/api/admin/microsoft-directory/departments");
      if (listRes.ok) {
        const data = await listRes.json();
        setDirectoryValues(data.values ?? []);
        setDirectoryLastSyncedAt(data.lastSyncedAt ?? null);
      }
      toast.success("Directory departments synced from Microsoft");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to sync directory departments");
    } finally {
      setSyncing(false);
    }
  };

  const handleSave = async () => {
    if (!value.trim() || !departmentId) return;
    setSaving(true);
    try {
      const payload = { sourceType, microsoftValue: value.trim(), departmentId, role };
      const res = await fetch(
        editingMapping ? `/api/admin/microsoft-mappings/${editingMapping.id}` : "/api/admin/microsoft-mappings",
        {
          method: editingMapping ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to save mapping");
      }
      const saved = await res.json();
      const dept = departments.find((d) => d.id === departmentId);
      const view: Mapping = { ...saved, department: { id: departmentId, name: dept?.name ?? "", slug: "" } };

      if (editingMapping) {
        setMappings((prev) => prev.map((m) => (m.id === editingMapping.id ? { ...m, ...view } : m)));
        toast.success("Mapping updated");
      } else {
        setMappings((prev) => [...prev, view]);
        toast.success("Mapping created");
      }
      setDialogOpen(false);
      resetForm();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to save mapping");
    } finally {
      setSaving(false);
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

  const isProfileDepartment = sourceType === MicrosoftMappingSourceType.PROFILE_DEPARTMENT;
  const showDropdown = isProfileDepartment && !manualEntry;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {mappings.length} mapping{mappings.length !== 1 ? "s" : ""} — inactive mappings are ignored by login sync.
          Changes apply on the next Microsoft login/sync, not immediately.
        </p>
        <Button onClick={openCreate} size="sm" disabled={departments.length === 0}>
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
              <TableHead className="w-24"></TableHead>
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
                    <div className="flex items-center gap-0.5">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(m)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(m)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingMapping ? "Edit Microsoft Mapping" : "Add Microsoft Mapping"}</DialogTitle>
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
              {sourceType !== MicrosoftMappingSourceType.PROFILE_DEPARTMENT && (
                <p className="text-xs text-amber-700">
                  Directory discovery isn&apos;t implemented for this source type yet — enter the exact
                  {sourceType === MicrosoftMappingSourceType.ENTRA_GROUP ? " group name or object id" : " app role value"} manually.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Microsoft Value</Label>
                {isProfileDepartment && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {directoryLastSyncedAt ? `Synced ${formatDateTime(directoryLastSyncedAt)}` : "Never synced"}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5"
                      onClick={handleSync}
                      disabled={syncing}
                      title="Sync department values from Microsoft"
                    >
                      {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    </Button>
                  </div>
                )}
              </div>

              {showDropdown ? (
                directoryValues.length > 0 ? (
                  <Select value={value} onValueChange={setValue}>
                    <SelectTrigger><SelectValue placeholder="Select a department value" /></SelectTrigger>
                    <SelectContent>
                      {directoryValues.map((v) => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground border rounded-md p-2">
                    No cached values yet — click the sync button above, or use manual entry below. Syncing requires
                    the Microsoft Graph <code className="text-[11px] bg-muted px-1 rounded">Directory.Read.All</code>{" "}
                    Application permission, admin-consented in Microsoft Entra admin center on the app registration
                    used by GRAPH_CLIENT_ID. This is a different operation from the per-user login sync
                    (which uses User.Read and is unaffected) — login keeps working even if this hasn&apos;t been granted yet.
                  </p>
                )
              ) : (
                <Input
                  placeholder='e.g. "Systems Operations"'
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}

              {isProfileDepartment && (
                <>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-input"
                      checked={manualEntry}
                      onChange={(e) => setManualEntry(e.target.checked)}
                    />
                    Enter value manually (fallback only — prefer syncing from Microsoft Graph above)
                  </label>
                  {manualEntry && (
                    <p className="text-[11px] text-amber-700">
                      Must be an exact match (including casing and spacing) with Microsoft Graph&apos;s{" "}
                      <code className="bg-muted px-1 rounded">user.department</code> value for this to work at login.
                    </p>
                  )}
                </>
              )}
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
            <Button variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !value.trim() || !departmentId}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingMapping ? "Save Changes" : "Create Mapping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
