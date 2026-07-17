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
  GLOBAL_ROLE_LABELS,
} from "@/components/admin/department-role-info";
import { translateDepartmentRoleToGlobalRole } from "@/lib/services/department-role-translation";

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

interface DirectoryCache {
  values: string[];
  lastSyncedAt: string | null;
}

interface MicrosoftMappingManagementProps {
  mappings: Mapping[];
  departments: DepartmentOption[];
  departmentDirectory: DirectoryCache;
  jobTitleDirectory: DirectoryCache;
}

// Source types with a real Graph-backed dropdown today — everything else
// (Entra Group, Entra App Role) stays manual-entry only until directory
// discovery is built for them too.
const DIRECTORY_BACKED_SOURCE_TYPES: MicrosoftMappingSourceType[] = [
  MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
  MicrosoftMappingSourceType.PROFILE_JOB_TITLE,
];

export function MicrosoftMappingManagement({
  mappings: initialMappings,
  departments,
  departmentDirectory: initialDepartmentDirectory,
  jobTitleDirectory: initialJobTitleDirectory,
}: MicrosoftMappingManagementProps) {
  const [mappings, setMappings] = useState(initialMappings);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [departmentDirectory, setDepartmentDirectory] = useState(initialDepartmentDirectory);
  const [jobTitleDirectory, setJobTitleDirectory] = useState(initialJobTitleDirectory);
  const [syncing, setSyncing] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<Mapping | null>(null);
  const [saving, setSaving] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [sourceType, setSourceType] = useState<MicrosoftMappingSourceType>(MicrosoftMappingSourceType.ENTRA_GROUP);
  const [value, setValue] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  const [role, setRole] = useState<DepartmentRole>(DepartmentRole.REQUESTER);

  const isDirectoryBacked = DIRECTORY_BACKED_SOURCE_TYPES.includes(sourceType);
  const isProfileDepartment = sourceType === MicrosoftMappingSourceType.PROFILE_DEPARTMENT;
  const isProfileJobTitle = sourceType === MicrosoftMappingSourceType.PROFILE_JOB_TITLE;
  const activeDirectory = isProfileDepartment ? departmentDirectory : isProfileJobTitle ? jobTitleDirectory : null;
  const showDropdown = isDirectoryBacked && !manualEntry;

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
    // If the mapping's current value isn't in the relevant cached directory
    // list, default to manual entry so the admin sees the real stored value
    // instead of an empty/mismatched dropdown.
    const cache =
      mapping.sourceType === MicrosoftMappingSourceType.PROFILE_DEPARTMENT
        ? departmentDirectory
        : mapping.sourceType === MicrosoftMappingSourceType.PROFILE_JOB_TITLE
          ? jobTitleDirectory
          : null;
    setManualEntry(
      DIRECTORY_BACKED_SOURCE_TYPES.includes(mapping.sourceType) &&
        !cache?.values.some((v) => v.toLowerCase() === mapping.microsoftValue.toLowerCase())
    );
    setDialogOpen(true);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/microsoft-directory/values/sync", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Sync failed");
      }
      const listRes = await fetch("/api/admin/microsoft-directory/values");
      if (listRes.ok) {
        const data = await listRes.json();
        setDepartmentDirectory(data.departments ?? { values: [], lastSyncedAt: null });
        setJobTitleDirectory(data.jobTitles ?? { values: [], lastSyncedAt: null });
      }
      toast.success("Microsoft directory values synced (departments and job titles)");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to sync Microsoft directory values");
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {mappings.length} mapping{mappings.length !== 1 ? "s" : ""} — inactive mappings are ignored by login sync.
          Changes apply on the next Microsoft login/sync, not immediately. Department and job title values also
          appear automatically as users log in — a full sync just preloads everything at once.
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
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:w-full sm:max-w-2xl">
          <DialogHeader className="shrink-0 border-b px-6 py-4 pr-10">
            <DialogTitle>{editingMapping ? "Edit Microsoft Mapping" : "Add Microsoft Mapping"}</DialogTitle>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            <div className="space-y-2">
              <Label>Source Type</Label>
              <Select
                value={sourceType}
                onValueChange={(v) => { setSourceType(v as MicrosoftMappingSourceType); setManualEntry(false); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MAPPING_SOURCE_TYPE_OPTIONS.map((t) => (
                    <SelectItem key={t} value={t}>{MAPPING_SOURCE_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{MAPPING_SOURCE_TYPE_HELP[sourceType]}</p>
              {!isDirectoryBacked && (
                <p className="text-xs text-amber-700">
                  Directory discovery isn&apos;t implemented for this source type yet — enter the exact
                  {sourceType === MicrosoftMappingSourceType.ENTRA_GROUP ? " group name or object id" : " app role value"} manually.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Microsoft Value</Label>
                {isDirectoryBacked && (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                      {activeDirectory?.lastSyncedAt ? `Synced ${formatDateTime(activeDirectory.lastSyncedAt)}` : "Never synced"}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1.5"
                      onClick={handleSync}
                      disabled={syncing}
                      title="Sync department and job title values from Microsoft"
                    >
                      {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    </Button>
                  </div>
                )}
              </div>

              {showDropdown ? (
                (activeDirectory?.values.length ?? 0) > 0 ? (
                  <Select value={value} onValueChange={setValue}>
                    <SelectTrigger>
                      <SelectValue placeholder={`Select a ${isProfileJobTitle ? "job title" : "department"} value`} />
                    </SelectTrigger>
                    <SelectContent>
                      {activeDirectory?.values.map((v) => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="rounded-md border p-2 text-xs text-muted-foreground">
                    No cached values yet — sync above, or enter manually below. Values also appear automatically as
                    users log in (see &quot;More about mapping behavior&quot; below for permission details).
                  </p>
                )
              ) : (
                <Input
                  placeholder={isProfileJobTitle ? 'e.g. "Systems Operations Manager"' : 'e.g. "Systems Operations"'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              )}

              {isDirectoryBacked && (
                <>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 rounded border-input"
                      checked={manualEntry}
                      onChange={(e) => setManualEntry(e.target.checked)}
                    />
                    Enter value manually (fallback only)
                  </label>
                  {manualEntry && (
                    <p className="text-[11px] text-amber-700">
                      {isProfileJobTitle ? (
                        <>
                          Must match Microsoft Graph&apos;s <code className="bg-muted px-1 rounded">user.jobTitle</code>{" "}
                          value, ignoring only leading/trailing spaces and letter case.
                        </>
                      ) : (
                        <>
                          Must be an exact match (including casing and spacing) with Microsoft Graph&apos;s{" "}
                          <code className="bg-muted px-1 rounded">user.department</code> value for this to work at login.
                        </>
                      )}
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
              <p className="text-xs text-muted-foreground">
                Global Role granted: <span className="font-medium text-foreground">{GLOBAL_ROLE_LABELS[translateDepartmentRoleToGlobalRole(role)]}</span>
                {" "}— unless manually overridden.
              </p>
              {(role === "DEPARTMENT_ADMIN" || role === "DEPARTMENT_MANAGER") && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                  Grants elevated global access ({GLOBAL_ROLE_LABELS[translateDepartmentRoleToGlobalRole(role)]}) to every
                  matching user, not just department-scoped access — review before saving.
                </p>
              )}
            </div>

            <details className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">More about mapping behavior</summary>
              <div className="mt-2 space-y-1.5">
                <p>
                  This mapping sets both the TicketApp Department and the user&apos;s Global Role / Department
                  Membership Role, unless manually overridden. Changes apply on the next Microsoft login/sync — not
                  immediately for existing users.
                </p>
                <p>Microsoft mappings can never grant System Admin — that always requires a manual admin action.</p>
                {isDirectoryBacked && (
                  <p>
                    Full-tenant syncing requires the Microsoft Graph{" "}
                    <code className="rounded bg-muted px-1">Directory.Read.All</code> Application permission,
                    admin-consented in Microsoft Entra admin center — the per-user login sync (User.Read) is
                    unaffected either way.
                  </p>
                )}
                {isProfileJobTitle && (
                  <p>
                    Job title mappings are useful when users share the same department but need different TicketApp
                    roles — a job title mapping overrides a department-only mapping for the same department.
                  </p>
                )}
              </div>
            </details>
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t px-6 py-4">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => { setDialogOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving || !value.trim() || !departmentId}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingMapping ? "Save Changes" : "Create Mapping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
