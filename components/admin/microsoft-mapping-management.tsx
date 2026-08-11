"use client";

import { useState, useRef } from "react";
import { toast } from "sonner";
import { DepartmentRole, MicrosoftMappingSourceType, Role } from "@prisma/client";
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
import { Plus, Loader2, Trash2, Pencil, RefreshCw, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import {
  GLOBAL_ROLE_LABELS,
  MAPPING_SOURCE_TYPE_LABELS,
  MAPPING_SOURCE_TYPE_HELP,
  MAPPING_SOURCE_TYPE_OPTIONS,
} from "@/components/admin/department-role-info";
import {
  translateGlobalRoleToDepartmentRole,
  DEPARTMENT_ROLE_LABELS,
} from "@/lib/services/department-role-translation";

// Live, database-backed role choices — built-in roles plus any active custom
// role of the matching scope — fetched from GET
// /api/admin/microsoft-mappings/role-options (see
// lib/services/microsoft-mapping-role-options-service.ts), never a
// build-time constant. `initialGlobalRoleOptions`/`initialDepartmentRoleOptions`
// (server-rendered, always fresh at page load) seed state for instant first
// paint; the dialog re-fetches every time it opens (openCreate/openEdit) so
// a role created moments ago without a page reload still shows up — see
// fetchRoleOptions below.
interface RoleOptionDto {
  /** Built-in: the Role/DepartmentRole enum value itself. Custom: `custom:<CustomRole.id>`. */
  value: string;
  label: string;
  description?: string;
  isCustom: boolean;
  customRoleId?: string;
}

interface Mapping {
  id: string;
  sourceType: MicrosoftMappingSourceType;
  microsoftValue: string;
  /** "" (global) for every non-domain-scoped sourceType; a real Entra domain (e.g. "kinsen.gr") for PROFILE_JOB_TITLE — see microsoft-mapping-service.ts's isDomainScopedMicrosoftMappingSourceType. */
  domain: string;
  departmentId: string;
  role: Role;
  globalCustomRoleId: string | null;
  globalCustomRole: { id: string; name: string; isActive: boolean } | null;
  departmentRole: DepartmentRole;
  departmentCustomRoleId: string | null;
  departmentCustomRole: { id: string; name: string; isActive: boolean } | null;
  isActive: boolean;
  department: { id: string; name: string; slug: string };
}

/** Display label for a mapping row's Global Role — the joined custom role name when set, else the built-in enum label. */
function mappingGlobalRoleLabel(m: Pick<Mapping, "role" | "globalCustomRole">): string {
  return m.globalCustomRole?.name ?? GLOBAL_ROLE_LABELS[m.role];
}

/** Same idea, department-scoped. */
function mappingDepartmentRoleLabel(m: Pick<Mapping, "departmentRole" | "departmentCustomRole">): string {
  return m.departmentCustomRole?.name ?? DEPARTMENT_ROLE_LABELS[m.departmentRole];
}

/**
 * The <Select> value for a mapping's current role — `custom:<id>` when a
 * custom role is set, else the built-in enum value. Used both to seed
 * dialog state on openEdit and to keep the two derived-label helpers above
 * (which read the raw mapping fields, not this encoded string) in sync.
 */
function roleSelectValue(customRoleId: string | null, enumValue: string): string {
  return customRoleId ? `custom:${customRoleId}` : enumValue;
}

/**
 * If the mapping's currently-stored custom role id isn't present in the
 * freshly-fetched options (deactivated, or simply not "assignable" for a
 * NEW pick anymore), inject it as a clearly-labeled synthetic option so the
 * dialog shows the real historical selection instead of silently falling
 * back to a default — "current selection that becomes ineligible" must
 * never be silently downgraded. The admin must explicitly pick something
 * else to change it; leaving it selected and saving keeps it as-is (a valid
 * choice, not just a display quirk), since updateMapping only re-validates
 * activeness for a genuinely NEW assignment (see
 * assertGlobalCustomRoleEligible in lib/services/microsoft-mapping-service.ts).
 */
function withPreservedSelection(
  options: RoleOptionDto[],
  currentCustomRoleId: string | null | undefined,
  currentCustomRoleName: string | null | undefined
): RoleOptionDto[] {
  if (!currentCustomRoleId) return options;
  const value = `custom:${currentCustomRoleId}`;
  if (options.some((o) => o.value === value)) return options;
  return [
    {
      value,
      label: `${currentCustomRoleName ?? "Unknown role"} (no longer eligible — pick a different role to change)`,
      isCustom: true,
      customRoleId: currentCustomRoleId,
    },
    ...options,
  ];
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface DirectoryCache {
  values: string[];
  lastSyncedAt: string | null;
}

interface JobTitleDiscoveryMapping {
  id: string;
  departmentId: string;
  departmentName: string;
  role: Role;
  globalCustomRoleName: string | null;
  departmentRole: DepartmentRole;
  departmentCustomRoleName: string | null;
  isActive: boolean;
}

interface JobTitleDiscoveryRow {
  id: string;
  value: string;
  userCount: number;
  isActive: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  configured: boolean;
  mapping: JobTitleDiscoveryMapping | null;
}

interface MicrosoftMappingManagementProps {
  mappings: Mapping[];
  departments: DepartmentOption[];
  departmentDirectory: DirectoryCache;
  jobTitleDirectory: DirectoryCache;
  jobTitleDiscoveryDomain: string;
  jobTitleDiscoveryRows: JobTitleDiscoveryRow[];
  /** Server-rendered, always-fresh-at-page-load role options — see the RoleOptionDto comment above. */
  initialGlobalRoleOptions: RoleOptionDto[];
  initialDepartmentRoleOptions: RoleOptionDto[];
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
  jobTitleDiscoveryDomain,
  jobTitleDiscoveryRows: initialJobTitleDiscoveryRows,
  initialGlobalRoleOptions,
  initialDepartmentRoleOptions,
}: MicrosoftMappingManagementProps) {
  const [mappings, setMappings] = useState(initialMappings);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [departmentDirectory, setDepartmentDirectory] = useState(initialDepartmentDirectory);
  const [jobTitleDirectory, setJobTitleDirectory] = useState(initialJobTitleDirectory);
  const [syncing, setSyncing] = useState(false);

  const [jobTitleDiscoveryRows, setJobTitleDiscoveryRows] = useState(initialJobTitleDiscoveryRows);
  const [jobTitleSyncing, setJobTitleSyncing] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMapping, setEditingMapping] = useState<Mapping | null>(null);
  const [saving, setSaving] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [sourceType, setSourceType] = useState<MicrosoftMappingSourceType>(MicrosoftMappingSourceType.ENTRA_GROUP);
  const [value, setValue] = useState("");
  // FIND-006: "" for every global sourceType; a real domain only for
  // PROFILE_JOB_TITLE. Never a free-text input today (no domain selector UI
  // yet, per explicit scope) — always auto-set to jobTitleDiscoveryDomain
  // when sourceType becomes PROFILE_JOB_TITLE (see the Source Type
  // onValueChange handler and openCreateFromJobTitle below), or restored
  // verbatim from the mapping being edited.
  const [domain, setDomain] = useState("");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");
  // Encoded Select value — a built-in Role/DepartmentRole enum member, or
  // `custom:<CustomRole.id>` — resolved back into the real
  // {role,globalCustomRoleId}/{departmentRole,departmentCustomRoleId} API
  // shape in handleSave, mirroring the exact pattern already used by
  // user-management.tsx / department-members-management.tsx.
  const [role, setRole] = useState<string>(Role.USER);
  const [departmentRole, setDepartmentRole] = useState<string>(translateGlobalRoleToDepartmentRole(Role.USER));
  // Once the admin edits Department Role directly, stop auto-suggesting a
  // new default when Global Role changes — never silently overwrite an
  // explicit choice. Starts true in edit mode (see openEdit below), so
  // opening an existing mapping never re-suggests over its stored value.
  const [departmentRoleTouched, setDepartmentRoleTouched] = useState(false);

  // Live role options — seeded from the server-rendered initial props,
  // refreshed every time the dialog opens (fetchRoleOptions, called from
  // openCreate/openEdit) so a role created moments ago in Roles &
  // Permissions, without a page reload, still appears (never a stale
  // build-time/page-load-time-only list).
  const [globalRoleOptions, setGlobalRoleOptions] = useState<RoleOptionDto[]>(initialGlobalRoleOptions);
  const [departmentRoleOptionsState, setDepartmentRoleOptionsState] = useState<RoleOptionDto[]>(initialDepartmentRoleOptions);
  const [roleOptionsLoading, setRoleOptionsLoading] = useState(false);
  // Stale-response guard for the role-options fetch — the dialog can be
  // closed/reopened faster than a fetch resolves; only the LATEST request's
  // response is ever applied to state.
  const roleOptionsRequestRef = useRef(0);

  const fetchRoleOptions = async (forMapping?: Mapping) => {
    const requestId = ++roleOptionsRequestRef.current;
    setRoleOptionsLoading(true);
    try {
      const res = await fetch("/api/admin/microsoft-mappings/role-options");
      if (roleOptionsRequestRef.current !== requestId) return; // a newer request already landed
      if (!res.ok) return; // keep whatever options we already had — non-fatal
      const data = await res.json();
      const global = withPreservedSelection(
        Array.isArray(data.globalRoles) ? data.globalRoles : [],
        forMapping?.globalCustomRoleId,
        forMapping?.globalCustomRole?.name
      );
      const dept = withPreservedSelection(
        Array.isArray(data.departmentRoles) ? data.departmentRoles : [],
        forMapping?.departmentCustomRoleId,
        forMapping?.departmentCustomRole?.name
      );
      setGlobalRoleOptions(global);
      setDepartmentRoleOptionsState(dept);
    } catch {
      // keep whatever options we already had — non-fatal, dialog stays usable
    } finally {
      if (roleOptionsRequestRef.current === requestId) setRoleOptionsLoading(false);
    }
  };

  const isDirectoryBacked = DIRECTORY_BACKED_SOURCE_TYPES.includes(sourceType);
  const isProfileDepartment = sourceType === MicrosoftMappingSourceType.PROFILE_DEPARTMENT;
  const isProfileJobTitle = sourceType === MicrosoftMappingSourceType.PROFILE_JOB_TITLE;
  const activeDirectory = isProfileDepartment ? departmentDirectory : isProfileJobTitle ? jobTitleDirectory : null;
  const showDropdown = isDirectoryBacked && !manualEntry;
  const selectedRoleOption = globalRoleOptions.find((opt) => opt.value === role);
  const selectedDepartmentRoleOption = departmentRoleOptionsState.find((opt) => opt.value === departmentRole);

  const handleRoleChange = (v: string) => {
    setRole(v);
    // Auto-suggestion only makes sense going FROM a real built-in Role — a
    // custom global role has no meaningful DepartmentRole translation, so
    // picking one simply leaves whatever Department Role is already set.
    if (!departmentRoleTouched && (Object.values(Role) as string[]).includes(v)) {
      setDepartmentRole(translateGlobalRoleToDepartmentRole(v as Role));
    }
  };

  const handleDepartmentRoleChange = (v: string) => {
    setDepartmentRole(v);
    setDepartmentRoleTouched(true);
  };

  const resetForm = () => {
    setEditingMapping(null);
    setSourceType(MicrosoftMappingSourceType.ENTRA_GROUP);
    setValue("");
    setDomain("");
    setDepartmentId(departments[0]?.id ?? "");
    setRole(Role.USER);
    setDepartmentRole(translateGlobalRoleToDepartmentRole(Role.USER));
    setDepartmentRoleTouched(false);
    setManualEntry(false);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
    // Refresh options every time the dialog opens (not just once at page
    // load) — a role created moments ago in Roles & Permissions, without a
    // page reload, must still appear here (see fetchRoleOptions's own
    // comment).
    fetchRoleOptions();
  };

  const openEdit = (mapping: Mapping) => {
    setEditingMapping(mapping);
    setSourceType(mapping.sourceType);
    setValue(mapping.microsoftValue);
    // Preserved verbatim, never re-derived or reset — "edit existing
    // mapping preserves domain" (FIND-006).
    setDomain(mapping.domain);
    setDepartmentId(mapping.departmentId);
    setRole(roleSelectValue(mapping.globalCustomRoleId, mapping.role));
    setDepartmentRole(roleSelectValue(mapping.departmentCustomRoleId, mapping.departmentRole));
    // Seed as "touched" so tweaking Global Role while editing never silently
    // overwrites this mapping's already-stored Department Role.
    setDepartmentRoleTouched(true);
    fetchRoleOptions(mapping);
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

  const refreshJobTitleDiscovery = async () => {
    const res = await fetch("/api/admin/microsoft-directory/job-titles");
    if (res.ok) {
      const data = await res.json();
      setJobTitleDiscoveryRows(data.rows ?? []);
    }
  };

  const handleJobTitleSync = async () => {
    setJobTitleSyncing(true);
    try {
      const res = await fetch("/api/admin/microsoft-directory/job-titles/sync", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Sync failed");
      }
      const summary = await res.json();
      await refreshJobTitleDiscovery();
      // Also refresh the mapping-form dropdown cache — the same Graph scan
      // just refreshed it too.
      const listRes = await fetch("/api/admin/microsoft-directory/values");
      if (listRes.ok) {
        const data = await listRes.json();
        setDepartmentDirectory(data.departments ?? { values: [], lastSyncedAt: null });
        setJobTitleDirectory(data.jobTitles ?? { values: [], lastSyncedAt: null });
      }
      const extra = summary.otherDomainsObserved?.length
        ? ` (other domains observed in the tenant, not processed: ${summary.otherDomainsObserved.join(", ")})`
        : "";
      toast.success(
        `Job titles synced for @${summary.domain}: ${summary.discovered} discovered, ${summary.added} new, ${summary.staled} no longer seen${extra}`
      );
    } catch (error: any) {
      toast.error(error.message ?? "Failed to sync Microsoft job titles");
    } finally {
      setJobTitleSyncing(false);
    }
  };

  const openCreateFromJobTitle = (value: string) => {
    resetForm();
    setSourceType(MicrosoftMappingSourceType.PROFILE_JOB_TITLE);
    setValue(value);
    // FIND-006: the discovered row's domain is passed automatically — the
    // admin never re-types it (every row in this panel already shares
    // jobTitleDiscoveryDomain, since listJobTitleDirectoryForAdmin is itself
    // scoped to one domain at a time).
    setDomain(jobTitleDiscoveryDomain);
    setDialogOpen(true);
    fetchRoleOptions();
  };

  const handleSave = async () => {
    if (!value.trim() || !departmentId) return;
    setSaving(true);
    try {
      // Resolve the encoded Select value back into the real API shape —
      // exactly the pattern already used by user-management.tsx
      // (roleOptions.find + enumRole/customRoleId) and
      // department-members-management.tsx (roleBody). A custom pick sends
      // its customRoleId and omits the enum value entirely (the service
      // forces the placeholder itself); a built-in pick sends the enum
      // value and explicit `null` so an edit can clear a previously-set
      // custom role back to a built-in one.
      const payload = {
        sourceType,
        microsoftValue: value.trim(),
        departmentId,
        ...(selectedRoleOption?.isCustom
          ? { globalCustomRoleId: selectedRoleOption.customRoleId }
          : { role: role as Role, globalCustomRoleId: null }),
        ...(selectedDepartmentRoleOption?.isCustom
          ? { departmentCustomRoleId: selectedDepartmentRoleOption.customRoleId }
          : { departmentRole: departmentRole as DepartmentRole, departmentCustomRoleId: null }),
        ...(isProfileJobTitle ? { domain } : {}),
      };
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
      // The create/update API returns the raw row only (no joined
      // globalCustomRole/departmentCustomRole names) — built here from the
      // already-fetched, already-validated selectedRoleOption/
      // selectedDepartmentRoleOption instead of a second round-trip.
      const view: Mapping = {
        ...saved,
        department: { id: departmentId, name: dept?.name ?? "", slug: "" },
        globalCustomRole:
          selectedRoleOption?.isCustom && selectedRoleOption.customRoleId
            ? { id: selectedRoleOption.customRoleId, name: selectedRoleOption.label, isActive: true }
            : null,
        departmentCustomRole:
          selectedDepartmentRoleOption?.isCustom && selectedDepartmentRoleOption.customRoleId
            ? { id: selectedDepartmentRoleOption.customRoleId, name: selectedDepartmentRoleOption.label, isActive: true }
            : null,
      };

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
      // Drains the (empty, 204) response body — avoids a Chromium DevTools
      // quirk where an unread fetch() response can be reported as
      // net::ERR_ABORTED despite completing successfully.
      await res.text().catch(() => {});
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
              <TableHead>Domain</TableHead>
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
                  {m.domain ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-purple-50 text-purple-700 border-purple-200">
                      {m.domain}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Global</span>
                  )}
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{m.microsoftValue}</code>
                </TableCell>
                <TableCell>
                  <span className="text-sm">
                    {m.department.name}{" "}
                    <span className="text-muted-foreground">
                      — {mappingGlobalRoleLabel(m)}
                      {m.globalCustomRole && <span className="text-[10px]"> (Custom)</span>} /{" "}
                      {mappingDepartmentRoleLabel(m)}
                      {m.departmentCustomRole && <span className="text-[10px]"> (Custom)</span>}
                    </span>
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
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                  No Microsoft mappings yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Job Titles — Auto-Discovery</h2>
            <p className="text-xs text-muted-foreground">
              Distinct <code className="bg-muted px-1 rounded">jobTitle</code> values seen among real{" "}
              <code className="bg-muted px-1 rounded">@{jobTitleDiscoveryDomain}</code> users in Microsoft/Entra —
              other domains/guest accounts are never included. Configure a mapping for any title below to grant it a
              department and role automatically on login/sync.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={handleJobTitleSync} disabled={jobTitleSyncing}>
            {jobTitleSyncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Sync Microsoft Job Titles
          </Button>
        </div>

        <div className="rounded-md border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead>Job Title</TableHead>
                <TableHead className="w-24">Users</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Seen</TableHead>
                <TableHead className="w-32"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobTitleDiscoveryRows.map((row) => (
                <TableRow key={row.id} className={!row.isActive ? "opacity-60" : undefined}>
                  <TableCell>
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{row.value}</code>
                    {!row.isActive && <span className="ml-2 text-[11px] text-muted-foreground">not seen in last sync</span>}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                      <Users className="h-3.5 w-3.5" />
                      {row.userCount}
                    </span>
                  </TableCell>
                  <TableCell>
                    {row.configured && row.mapping ? (
                      <Badge className="border-green-200 bg-green-50 text-green-700" variant="outline">
                        Configured — {row.mapping.departmentName} ({row.mapping.globalCustomRoleName ?? GLOBAL_ROLE_LABELS[row.mapping.role]})
                      </Badge>
                    ) : (
                      <Badge className="border-amber-200 bg-amber-50 text-amber-700" variant="outline">
                        Not configured
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.lastSeenAt)}</TableCell>
                  <TableCell>
                    {!row.configured && (
                      <Button size="sm" variant="ghost" onClick={() => openCreateFromJobTitle(row.value)}>
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        Map
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {jobTitleDiscoveryRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                    No job titles discovered yet — click &quot;Sync Microsoft Job Titles&quot; above, or they&apos;ll
                    appear automatically as users log in.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
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
                onValueChange={(v) => {
                  const next = v as MicrosoftMappingSourceType;
                  setSourceType(next);
                  setManualEntry(false);
                  // FIND-006: switching TO the one domain-scoped source type
                  // auto-fills the (today, only) enabled domain — never left
                  // blank for the admin to guess; switching AWAY clears it,
                  // since every other source type is global.
                  setDomain(next === MicrosoftMappingSourceType.PROFILE_JOB_TITLE ? jobTitleDiscoveryDomain : "");
                }}
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
              {isProfileJobTitle && domain && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Domain:
                  <span className="rounded-full border bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 border-blue-200">
                    {domain}
                  </span>
                  — applied automatically, only <code className="bg-muted px-1 rounded">@{domain}</code> is enabled for
                  organization sync today.
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
              <div className="flex items-center justify-between">
                <Label>Global Role</Label>
                {roleOptionsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <Select value={role} onValueChange={handleRoleChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {globalRoleOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                      {opt.isCustom && !opt.label.includes("no longer eligible") ? " (Custom)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedRoleOption && (
                <>
                  {selectedRoleOption.description && (
                    <p className="text-xs text-muted-foreground">{selectedRoleOption.description}</p>
                  )}
                  {(role === "DEPARTMENT_MANAGER" || role === "DIRECTOR") && (
                    <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                      {role === "DIRECTOR"
                        ? "Grants view-and-create access across every department, not just this one — review before saving."
                        : `Grants elevated global access (${selectedRoleOption.label}) to every matching user, not just department-scoped access — review before saving.`}
                    </p>
                  )}
                </>
              )}
              <p className="text-[11px] text-muted-foreground">
                Global Role controls the user&apos;s app-wide role — built-in roles plus any active custom Global
                Role from Roles &amp; Permissions. Administrator cannot be granted automatically by Microsoft
                mappings — assign it manually from Roles &amp; Permissions or User Management.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Department Role</Label>
                {roleOptionsLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              <Select value={departmentRole} onValueChange={handleDepartmentRoleChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {departmentRoleOptionsState.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                      {opt.isCustom && !opt.label.includes("no longer eligible") ? " (Custom)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedDepartmentRoleOption?.description && (
                <p className="text-xs text-muted-foreground">{selectedDepartmentRoleOption.description}</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Department Role controls the user&apos;s membership role in the selected department — built-in
                roles plus any active custom Department Role, chosen independently of Global Role above (pre-filled
                with a sensible default until you change it). Department Admin cannot be granted automatically by
                Microsoft mappings.
              </p>
            </div>

            <details className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">More about mapping behavior</summary>
              <div className="mt-2 space-y-1.5">
                <p>
                  This mapping sets the TicketApp Department, the user&apos;s Global Role, and their Department
                  Role in that department — each chosen independently above — unless manually overridden. Changes
                  apply on the next Microsoft login/sync — not immediately for existing users.
                </p>
                <p>
                  Microsoft mappings can never grant System Admin (Global Role) or Department Admin (Department
                  Role) — those always require a manual admin action.
                </p>
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
            <Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving || !value.trim() || !departmentId || (isProfileJobTitle && !domain)}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingMapping ? "Save Changes" : "Create Mapping"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
