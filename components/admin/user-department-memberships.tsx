"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { DepartmentRole, MembershipSource } from "@prisma/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/utils";
import { Loader2, UserCheck, UserX, Plus } from "lucide-react";
import {
  MEMBERSHIP_SOURCE_LABELS,
  MEMBERSHIP_SOURCE_COLORS,
} from "@/components/admin/department-role-info";

export interface UserMembership {
  id: string;
  departmentId: string;
  role: DepartmentRole;
  /** Set when this membership's real role is a custom department role — `role` above is then just the required-but-unused VIEWER placeholder (see grantManualMembership). */
  customRoleId: string | null;
  customRole: { id: string; name: string; isActive: boolean } | null;
  source: MembershipSource;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  department: { id: string; name: string; slug: string };
}

/** A department-role choice — built-in DepartmentRole enum value or `custom:<CustomRole.id>` — from GET /api/admin/department-roles/options. */
interface DeptRoleOption {
  value: string;
  label: string;
  isCustom: boolean;
  customRoleId?: string;
  isActive: boolean;
}

/** The <Select> value for a membership's current role — matches how Microsoft Mapping's role selects encode the same built-in/custom distinction. */
function membershipRoleValue(m: Pick<UserMembership, "role" | "customRoleId">): string {
  return m.customRoleId ? `custom:${m.customRoleId}` : m.role;
}

interface UserDepartmentMembershipsProps {
  userId: string;
  memberships: UserMembership[];
  departments: { id: string; name: string; slug: string }[];
  onChange: (memberships: UserMembership[]) => void;
}

/**
 * Read/manage a single user's DepartmentMembership rows from the admin user
 * edit dialog. Reuses the exact same department-scoped endpoints Phase 3
 * built for the per-department members page
 * (POST/DELETE /api/admin/departments/{departmentId}/members[...]) — no new
 * backend, just a user-centric view over the same data.
 */
export function UserDepartmentMemberships({ userId, memberships, departments, onChange }: UserDepartmentMembershipsProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  // ── Add Membership (collapsed until opened, keeps the modal compact) ──
  const [addOpen, setAddOpen] = useState(false);
  const [addDeptId, setAddDeptId] = useState("");
  const [addRoleValue, setAddRoleValue] = useState("");
  const [adding, setAdding] = useState(false);
  // Fetched WITH disabled roles included (includeInactive=true) so an
  // existing membership already on a since-disabled role can still be shown
  // correctly (see membershipRoleOptions below) — `assignableRoleOptions`
  // (active only) is what's actually offered for a NEW selection, exactly
  // matching the pre-existing "Add Membership" behavior.
  const [allDeptRoleOptions, setAllDeptRoleOptions] = useState<DeptRoleOption[]>([]);
  const assignableRoleOptions = allDeptRoleOptions.filter((o) => o.isActive);

  useEffect(() => {
    fetch("/api/admin/department-roles/options?includeInactive=true")
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setAllDeptRoleOptions(Array.isArray(options) ? options : []))
      .catch(() => {});
  }, []);

  /**
   * The options a SPECIFIC membership row's Select should render: the
   * normal assignable (active) list, plus — only if this row's CURRENT role
   * isn't already in that list (i.e. it's since been disabled) — a
   * synthetic entry built from the row's own persisted data so the real
   * current role is shown clearly instead of silently falling back to
   * nothing/a default. Selecting anything else from the list still only
   * ever offers active roles, per the "disabled roles aren't offered for
   * new assignments" requirement.
   */
  function membershipRoleOptions(m: UserMembership): DeptRoleOption[] {
    const currentValue = membershipRoleValue(m);
    if (assignableRoleOptions.some((o) => o.value === currentValue)) return assignableRoleOptions;
    const known = allDeptRoleOptions.find((o) => o.value === currentValue);
    const currentLabel = m.customRoleId
      ? (m.customRole?.name ?? known?.label ?? "Unknown role")
      : (known?.label ?? m.role);
    return [
      {
        value: currentValue,
        label: `${currentLabel} (disabled)`,
        isCustom: !!m.customRoleId,
        customRoleId: m.customRoleId ?? undefined,
        isActive: false,
      },
      ...assignableRoleOptions,
    ];
  }

  // Departments the user doesn't already have an active membership in —
  // adding one where they're already active would just be a role change,
  // which the existing per-row Select below already handles.
  const activeDeptIds = new Set(memberships.filter((m) => m.isActive).map((m) => m.departmentId));
  const availableDepartments = departments.filter((d) => !activeDeptIds.has(d.id));

  const resetAdd = () => {
    setAddDeptId("");
    setAddRoleValue("");
    setAddOpen(false);
  };

  const handleAddMembership = async () => {
    if (!addDeptId || !addRoleValue) return;
    // A brand-new membership only ever offers currently-assignable
    // (active) roles — never the disabled-role synthetic entry, which only
    // ever appears for an EXISTING row via membershipRoleOptions above.
    const option = assignableRoleOptions.find((o) => o.value === addRoleValue);
    const body = option?.isCustom && option.customRoleId ? { userId, customRoleId: option.customRoleId } : { userId, role: addRoleValue };
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/departments/${addDeptId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to add membership");
      }
      const created = await res.json();
      const department = departments.find((d) => d.id === addDeptId)!;
      const existingIndex = memberships.findIndex((m) => m.departmentId === addDeptId);
      const newRow: UserMembership = {
        id: created.id,
        departmentId: addDeptId,
        role: created.role,
        customRoleId: created.customRoleId ?? null,
        customRole: option?.isCustom && option.customRoleId ? { id: option.customRoleId, name: option.label, isActive: true } : null,
        source: created.source,
        isActive: true,
        createdAt: created.createdAt ?? new Date().toISOString(),
        updatedAt: created.updatedAt ?? new Date().toISOString(),
        department,
      };
      onChange(
        existingIndex >= 0
          ? memberships.map((m, i) => (i === existingIndex ? newRow : m))
          : [...memberships, newRow]
      );
      toast.success(`Added to ${department.name}`);
      resetAdd();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to add membership");
    } finally {
      setAdding(false);
    }
  };

  /** `value` is whatever membershipRoleOptions(m) offered — a built-in DepartmentRole enum string or `custom:<id>` (see membershipRoleValue). */
  const handleChangeRole = async (membership: UserMembership, value: string) => {
    const option = [...assignableRoleOptions, ...allDeptRoleOptions].find((o) => o.value === value);
    const body =
      option?.isCustom && option.customRoleId
        ? { userId, customRoleId: option.customRoleId }
        : { userId, role: (option?.value ?? value) as DepartmentRole };
    setBusyId(membership.id);
    try {
      const res = await fetch(`/api/admin/departments/${membership.departmentId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update membership");
      }
      const updated = await res.json();
      onChange(
        memberships.map((m) =>
          m.id === membership.id
            ? {
                ...m,
                role: updated.role,
                customRoleId: updated.customRoleId ?? null,
                customRole: option?.isCustom && option.customRoleId ? { id: option.customRoleId, name: option.label, isActive: option.isActive } : null,
                source: MembershipSource.MANUAL,
                isActive: true,
                updatedAt: updated.updatedAt ?? new Date().toISOString(),
              }
            : m
        )
      );
      toast.success("Membership updated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update membership");
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (membership: UserMembership) => {
    setBusyId(membership.id);
    try {
      const res = await fetch(`/api/admin/departments/${membership.departmentId}/members/${membership.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to revoke membership");
      }
      onChange(memberships.map((m) => (m.id === membership.id ? { ...m, isActive: false } : m)));
      toast.success("Membership revoked");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to revoke membership");
    } finally {
      setBusyId(null);
    }
  };

  const addMembershipControl = (
    <div className="space-y-2">
      {!addOpen ? (
        <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)} disabled={availableDepartments.length === 0}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Membership
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5">
          <Select value={addDeptId} onValueChange={setAddDeptId}>
            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Department…" /></SelectTrigger>
            <SelectContent>
              {availableDepartments.map((d) => (
                <SelectItem key={d.id} value={d.id} className="text-xs">{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={addRoleValue} onValueChange={setAddRoleValue}>
            <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Role…" /></SelectTrigger>
            <SelectContent>
              {assignableRoleOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}{o.isCustom ? " (Custom)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" size="sm" onClick={handleAddMembership} disabled={adding || !addDeptId || !addRoleValue}>
            {adding && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Add
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={resetAdd} disabled={adding}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );

  if (memberships.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          No department memberships yet — this user has no active or past DepartmentMembership rows.
        </p>
        {addMembershipControl}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {addMembershipControl}
      <div className="rounded-lg border">
      <div className="max-h-64 overflow-y-auto overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Department</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memberships.map((m) => (
              <TableRow key={m.id} className={!m.isActive ? "opacity-60" : undefined}>
                <TableCell>
                  <p className="text-sm font-medium truncate max-w-[140px]" title={m.department.name}>{m.department.name}</p>
                  <p className="text-xs text-muted-foreground truncate max-w-[140px]">{m.department.slug}</p>
                </TableCell>
                <TableCell>
                  <Select
                    value={membershipRoleValue(m)}
                    onValueChange={(v) => handleChangeRole(m, v)}
                    disabled={busyId === m.id || !m.isActive}
                  >
                    <SelectTrigger className="h-8 w-40 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {membershipRoleOptions(m).map((o) => (
                        <SelectItem key={o.value} value={o.value} className="text-xs">
                          {o.label}{o.isCustom && o.isActive ? " (Custom)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {m.isActive && m.source !== MembershipSource.MANUAL && (
                    <p className="text-[11px] text-muted-foreground mt-1 max-w-40">
                      Changing this marks it as a manual override.
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${MEMBERSHIP_SOURCE_COLORS[m.source]}`}>
                    {MEMBERSHIP_SOURCE_LABELS[m.source]}
                  </span>
                </TableCell>
                <TableCell>
                  {m.isActive ? (
                    <span className="flex items-center gap-1 text-xs text-green-700 whitespace-nowrap">
                      <UserCheck className="h-3.5 w-3.5" /> Active
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-red-600 whitespace-nowrap">
                      <UserX className="h-3.5 w-3.5" /> Revoked
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(m.updatedAt)}</span>
                </TableCell>
                <TableCell>
                  {busyId === m.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : m.isActive ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-orange-500 hover:text-orange-600 hover:bg-orange-50"
                      onClick={() => handleRevoke(m)}
                    >
                      Revoke
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-green-600 hover:text-green-700 hover:bg-green-50"
                      onClick={() => handleChangeRole(m, membershipRoleValue(m))}
                      title="Reactivates as a manual admin override"
                    >
                      Reactivate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      </div>
    </div>
  );
}
