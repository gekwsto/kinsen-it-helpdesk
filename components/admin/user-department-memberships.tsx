"use client";

import { useState } from "react";
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
import { Loader2, UserCheck, UserX } from "lucide-react";
import {
  DEPARTMENT_ROLE_LABELS,
  DEPARTMENT_ROLE_OPTIONS,
  MEMBERSHIP_SOURCE_LABELS,
  MEMBERSHIP_SOURCE_COLORS,
} from "@/components/admin/department-role-info";

export interface UserMembership {
  id: string;
  departmentId: string;
  role: DepartmentRole;
  source: MembershipSource;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  department: { id: string; name: string; slug: string };
}

interface UserDepartmentMembershipsProps {
  userId: string;
  memberships: UserMembership[];
  onChange: (memberships: UserMembership[]) => void;
}

/**
 * Read/manage a single user's DepartmentMembership rows from the admin user
 * edit dialog. Reuses the exact same department-scoped endpoints Phase 3
 * built for the per-department members page
 * (POST/DELETE /api/admin/departments/{departmentId}/members[...]) — no new
 * backend, just a user-centric view over the same data.
 */
export function UserDepartmentMemberships({ userId, memberships, onChange }: UserDepartmentMembershipsProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleChangeRole = async (membership: UserMembership, role: DepartmentRole) => {
    setBusyId(membership.id);
    try {
      const res = await fetch(`/api/admin/departments/${membership.departmentId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update membership");
      }
      const updated = await res.json();
      onChange(
        memberships.map((m) =>
          m.id === membership.id
            ? { ...m, role, source: MembershipSource.MANUAL, isActive: true, updatedAt: updated.updatedAt ?? new Date().toISOString() }
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

  if (memberships.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-3">
        No department memberships yet — this user has no active or past DepartmentMembership rows.
      </p>
    );
  }

  return (
    <div className="rounded-lg border overflow-hidden">
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
                <p className="text-sm font-medium">{m.department.name}</p>
                <p className="text-xs text-muted-foreground">{m.department.slug}</p>
              </TableCell>
              <TableCell>
                <Select
                  value={m.role}
                  onValueChange={(v) => handleChangeRole(m, v as DepartmentRole)}
                  disabled={busyId === m.id || !m.isActive}
                >
                  <SelectTrigger className="h-8 w-44 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPARTMENT_ROLE_OPTIONS.map((role) => (
                      <SelectItem key={role} value={role} className="text-xs">
                        {DEPARTMENT_ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {m.isActive && m.source !== MembershipSource.MANUAL && (
                  <p className="text-[11px] text-muted-foreground mt-1 max-w-44">
                    Changing this marks it as a manual override — future Microsoft sync won&apos;t update it automatically.
                  </p>
                )}
              </TableCell>
              <TableCell>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${MEMBERSHIP_SOURCE_COLORS[m.source]}`}>
                  {MEMBERSHIP_SOURCE_LABELS[m.source]}
                </span>
              </TableCell>
              <TableCell>
                {m.isActive ? (
                  <span className="flex items-center gap-1 text-xs text-green-700">
                    <UserCheck className="h-3.5 w-3.5" /> Active
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-red-600">
                    <UserX className="h-3.5 w-3.5" /> Revoked
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="text-xs text-muted-foreground">{formatDateTime(m.updatedAt)}</span>
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
                    onClick={() => handleChangeRole(m, m.role)}
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
  );
}
