"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { DepartmentRole } from "@prisma/client";
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
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { Search, Plus, Loader2, UserX, UserCheck } from "lucide-react";
import {
  DEPARTMENT_ROLE_LABELS,
  DEPARTMENT_ROLE_DESCRIPTIONS,
  DEPARTMENT_ROLE_OPTIONS,
  MEMBERSHIP_SOURCE_LABELS,
  MEMBERSHIP_SOURCE_COLORS,
} from "@/components/admin/department-role-info";

interface Membership {
  id: string;
  userId: string;
  role: DepartmentRole;
  source: "MANUAL" | "MICROSOFT_DEPARTMENT" | "MICROSOFT_GROUP" | "MICROSOFT_APP_ROLE";
  isPrimary: boolean;
  isActive: boolean;
  user: { id: string; name: string | null; email: string; image: string | null };
}

interface SearchUser {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
}

interface DepartmentMembersManagementProps {
  departmentId: string;
  departmentName: string;
  memberships: Membership[];
}

export function DepartmentMembersManagement({
  departmentId,
  departmentName,
  memberships: initialMemberships,
}: DepartmentMembersManagementProps) {
  const router = useRouter();
  const [memberships, setMemberships] = useState(initialMemberships);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<SearchUser | null>(null);
  const [selectedRole, setSelectedRole] = useState<DepartmentRole>(DepartmentRole.REQUESTER);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!userQuery.trim() || selectedUser) {
      setUserResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/admin/users?search=${encodeURIComponent(userQuery)}`);
        const data = await res.json();
        setUserResults(Array.isArray(data) ? data.slice(0, 8) : []);
      } catch {
        setUserResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [userQuery, selectedUser]);

  const resetAdd = () => {
    setUserQuery("");
    setUserResults([]);
    setSelectedUser(null);
    setSelectedRole(DepartmentRole.REQUESTER);
  };

  const refreshMemberships = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/members`);
      if (!res.ok) return;
      setMemberships(await res.json());
    } catch {
      // keep whatever we had — a background refresh failing isn't worth surfacing
    }
  }, [departmentId]);

  const handleAdd = async () => {
    if (!selectedUser) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUser.id, role: selectedRole }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to add member");
      }
      toast.success(`${selectedUser.name ?? selectedUser.email} added to ${departmentName}`);
      setAddOpen(false);
      resetAdd();
      await refreshMemberships();
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to add member");
    } finally {
      setAdding(false);
    }
  };

  const handleChangeRole = async (membership: Membership, role: DepartmentRole) => {
    setBusyId(membership.id);
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: membership.userId, role }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to change role");
      }
      await refreshMemberships();
      toast.success("Role updated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to change role");
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (membership: Membership) => {
    setBusyId(membership.id);
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/members/${membership.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to revoke membership");
      }
      setMemberships((prev) => prev.map((m) => (m.id === membership.id ? { ...m, isActive: false } : m)));
      toast.success("Membership revoked");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to revoke membership");
    } finally {
      setBusyId(null);
    }
  };

  const handleReactivate = async (membership: Membership) => {
    // Reactivating via the admin UI is a deliberate action, so it goes
    // through the same grant endpoint (source becomes MANUAL) — matches
    // grantManualMembership's existing semantics, no separate endpoint.
    await handleChangeRole(membership, membership.role);
    setMemberships((prev) => prev.map((m) => (m.id === membership.id ? { ...m, isActive: true, source: "MANUAL" } : m)));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{memberships.length} membership{memberships.length !== 1 ? "s" : ""}</p>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          Add Member
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memberships.map((m) => (
              <TableRow key={m.id} className={!m.isActive ? "opacity-60" : undefined}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={m.user.image ?? undefined} />
                      <AvatarFallback className="text-xs">{getInitials(m.user.name)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium">{m.user.name ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{m.user.email}</p>
                    </div>
                  </div>
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
                      onClick={() => handleReactivate(m)}
                    >
                      Reactivate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {memberships.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  No members yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) resetAdd(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add member to {departmentName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>User</Label>
              {selectedUser ? (
                <div className="flex items-center justify-between rounded-lg border p-2.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-7 w-7">
                      <AvatarImage src={selectedUser.image ?? undefined} />
                      <AvatarFallback className="text-xs">{getInitials(selectedUser.name)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium">{selectedUser.name ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{selectedUser.email}</p>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedUser(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or email..."
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                    className="pl-9"
                  />
                  {(searching || userResults.length > 0) && (
                    <div className="mt-1.5 rounded-lg border bg-white shadow-sm max-h-56 overflow-y-auto">
                      {searching ? (
                        <div className="p-3 text-center">
                          <Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" />
                        </div>
                      ) : (
                        userResults.map((u) => (
                          <button
                            key={u.id}
                            type="button"
                            onClick={() => { setSelectedUser(u); setUserResults([]); }}
                            className="w-full flex items-center gap-2.5 p-2.5 text-left hover:bg-muted/50 transition-colors"
                          >
                            <Avatar className="h-7 w-7">
                              <AvatarImage src={u.image ?? undefined} />
                              <AvatarFallback className="text-xs">{getInitials(u.name)}</AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="text-sm font-medium">{u.name ?? "—"}</p>
                              <p className="text-xs text-muted-foreground">{u.email}</p>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as DepartmentRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DEPARTMENT_ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {DEPARTMENT_ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{DEPARTMENT_ROLE_DESCRIPTIONS[selectedRole]}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddOpen(false); resetAdd(); }}>Cancel</Button>
            <Button onClick={handleAdd} disabled={adding || !selectedUser}>
              {adding && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
