"use client";

import { useState, useEffect, useCallback } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials } from "@/lib/utils";
import { Search, Plus, Loader2, UserX, UserCheck } from "lucide-react";
import { MEMBERSHIP_SOURCE_LABELS, MEMBERSHIP_SOURCE_COLORS } from "@/components/admin/department-role-info";

interface Membership {
  id: string;
  userId: string;
  source: "MANUAL" | "MICROSOFT_DEPARTMENT" | "MICROSOFT_GROUP" | "MICROSOFT_APP_ROLE" | "MICROSOFT_JOB_TITLE";
  isActive: boolean;
  user: { id: string; name: string | null; email: string; image: string | null };
}

interface SearchUser {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
}

interface SubDepartmentMembersManagementProps {
  departmentId: string;
  subDepartmentId: string;
  subDepartmentName: string;
  memberships: Membership[];
}

export function SubDepartmentMembersManagement({
  departmentId,
  subDepartmentId,
  subDepartmentName,
  memberships: initialMemberships,
}: SubDepartmentMembersManagementProps) {
  const router = useRouter();
  const [memberships, setMemberships] = useState(initialMemberships);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const [userResults, setUserResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<SearchUser | null>(null);
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
  };

  const refreshMemberships = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/sub-departments/${subDepartmentId}/members`);
      if (!res.ok) return;
      setMemberships(await res.json());
    } catch {
      // background refresh failing isn't worth surfacing
    }
  }, [departmentId, subDepartmentId]);

  const handleAdd = async () => {
    if (!selectedUser) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/sub-departments/${subDepartmentId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: selectedUser.id }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to add member");
      }
      toast.success(`${selectedUser.name ?? selectedUser.email} added to ${subDepartmentName}`);
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

  const handleRevoke = async (membership: Membership) => {
    setBusyId(membership.id);
    try {
      const res = await fetch(
        `/api/admin/departments/${departmentId}/sub-departments/${subDepartmentId}/members/${membership.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to remove member");
      }
      setMemberships((prev) => prev.map((m) => (m.id === membership.id ? { ...m, isActive: false } : m)));
      toast.success("Member removed");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to remove member");
    } finally {
      setBusyId(null);
    }
  };

  const handleReactivate = async (membership: Membership) => {
    setBusyId(membership.id);
    try {
      const res = await fetch(`/api/admin/departments/${departmentId}/sub-departments/${subDepartmentId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: membership.userId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to reactivate member");
      }
      setMemberships((prev) => prev.map((m) => (m.id === membership.id ? { ...m, isActive: true, source: "MANUAL" } : m)));
      toast.success("Membership reactivated");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to reactivate member");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{memberships.length} member{memberships.length !== 1 ? "s" : ""}</p>
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
                      <UserX className="h-3.5 w-3.5" /> Removed
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {busyId === m.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : m.isActive ? (
                    <Button size="sm" variant="ghost" className="text-orange-500 hover:text-orange-600 hover:bg-orange-50" onClick={() => handleRevoke(m)}>
                      Remove
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="text-green-600 hover:text-green-700 hover:bg-green-50" onClick={() => handleReactivate(m)}>
                      Reactivate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {memberships.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-8">
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
            <DialogTitle>Add member to {subDepartmentName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>User</Label>
              <p className="text-xs text-muted-foreground">
                Must already be an active member of the parent department.
              </p>
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
