"use client";

import { useState, useEffect } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials, formatDateTime } from "@/lib/utils";
import { Role } from "@prisma/client";
import { Search, Pencil, Loader2, UserCheck, UserX, Plus, Ban, ShieldCheck, Trash2 } from "lucide-react";

interface CustomRole { id: string; key: string; name: string; isBuiltIn: boolean }

interface User {
  id: string;
  name?: string | null;
  email: string;
  image?: string | null;
  role: Role;
  isActive: boolean;
  createdAt: string;
  department?: { id: string; name: string } | null;
  businessUnit?: { id: string; name: string } | null;
  customRole?: { id: string; key: string; name: string } | null;
}

interface Department { id: string; name: string }
interface BusinessUnit { id: string; name: string }

interface UserManagementProps {
  users: User[];
  departments: Department[];
  businessUnits: BusinessUnit[];
  currentUserId: string;
}

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Dept. Manager",
  USER: "User",
};

const ROLE_COLORS: Record<Role, string> = {
  ADMIN: "bg-red-100 text-red-700",
  IT_AGENT: "bg-blue-100 text-blue-700",
  DEPARTMENT_MANAGER: "bg-purple-100 text-purple-700",
  USER: "bg-gray-100 text-gray-700",
};

// Represents a selectable role option (built-in enum or custom DB role)
interface RoleOption {
  value: string;       // enum role value for built-in, "custom:" + id for custom
  label: string;
  isCustom: boolean;
  customRoleId?: string;
  enumRole: Role;      // the enum role to store (USER as base for custom roles)
}

export function UserManagement({ users: initialUsers, departments, businessUnits, currentUserId }: UserManagementProps) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [search, setSearch] = useState("");
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);

  const [editUser, setEditUser] = useState<User | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editRoleValue, setEditRoleValue] = useState<string>("");
  const [editDept, setEditDept] = useState("");
  const [editBU, setEditBU] = useState("");
  const [editActive, setEditActive] = useState(true);

  const [blockingId, setBlockingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Create user state
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createEmail, setCreateEmail] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<Role>(Role.USER);
  const [createDept, setCreateDept] = useState("");
  const [createBU, setCreateBU] = useState("");

  useEffect(() => {
    fetch("/api/admin/roles")
      .then((r) => r.json())
      .then((data) => setCustomRoles(data.roles ?? []))
      .catch(() => {});
  }, []);

  // Build unified role options: built-in enum roles first, then custom non-built-in roles
  const roleOptions: RoleOption[] = [
    ...Object.entries(ROLE_LABELS).map(([value, label]) => ({
      value,
      label,
      isCustom: false,
      enumRole: value as Role,
    })),
    ...customRoles
      .filter((cr) => !cr.isBuiltIn)
      .map((cr) => ({
        value: `custom:${cr.id}`,
        label: `${cr.name} (Custom)`,
        isCustom: true,
        customRoleId: cr.id,
        enumRole: Role.USER,
      })),
  ];

  const getUserRoleDisplay = (user: User) => {
    if (user.customRole && !user.customRole.key.match(/^(ADMIN|IT_AGENT|DEPARTMENT_MANAGER|USER)$/)) {
      return { label: `${user.customRole.name} (Custom)`, color: "bg-teal-100 text-teal-700" };
    }
    return { label: ROLE_LABELS[user.role], color: ROLE_COLORS[user.role] };
  };

  const filtered = users.filter(
    (u) =>
      u.name?.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  const resetCreate = () => {
    setCreateName("");
    setCreateEmail("");
    setCreatePassword("");
    setCreateRole(Role.USER);
    setCreateDept("");
    setCreateBU("");
  };

  const handleCreate = async () => {
    if (!createName.trim() || !createEmail.trim() || !createPassword.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName,
          email: createEmail,
          password: createPassword,
          role: createRole,
          departmentId: createDept || undefined,
          businessUnitId: createBU || undefined,
          isActive: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create user");
      }
      const newUser = await res.json();
      setUsers((prev) => [...prev, newUser]);
      toast.success("User created successfully");
      setCreateOpen(false);
      resetCreate();
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  const handleQuickBlock = async (user: User) => {
    setBlockingId(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: user.role, isActive: !user.isActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update");
      }
      const updated = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, ...updated } : u)));
      toast.success(user.isActive ? "User blocked" : "User unblocked");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update user");
    } finally {
      setBlockingId(null);
    }
  };

  const handleDelete = async () => {
    if (!editUser) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/users/${editUser.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to delete user");
      }
      setUsers((prev) => prev.filter((u) => u.id !== editUser.id));
      toast.success("User deleted");
      setEditOpen(false);
      setDeleteConfirm(false);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to delete user");
      setDeleting(false);
    }
  };

  const openEdit = (user: User) => {
    setEditUser(user);
    // Determine current role value
    if (user.customRole && !user.customRole.key.match(/^(ADMIN|IT_AGENT|DEPARTMENT_MANAGER|USER)$/)) {
      setEditRoleValue(`custom:${user.customRole.id}`);
    } else {
      setEditRoleValue(user.role);
    }
    setEditDept(user.department?.id ?? "");
    setEditBU(user.businessUnit?.id ?? "");
    setEditActive(user.isActive);
    setDeleteConfirm(false);
    setEditOpen(true);
  };

  const handleSave = async () => {
    if (!editUser) return;
    setSaving(true);
    try {
      // Resolve role option
      const option = roleOptions.find((o) => o.value === editRoleValue);
      const role = option?.enumRole ?? Role.USER;
      const customRoleId = option?.isCustom ? (option.customRoleId ?? null) : null;

      const res = await fetch(`/api/admin/users/${editUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          customRoleId,
          departmentId: editDept || null,
          businessUnitId: editBU || null,
          isActive: editActive,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update user");
      }
      const updated = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === editUser.id ? { ...u, ...updated } : u)));
      toast.success("User updated successfully");
      setEditOpen(false);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update user");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {filtered.length} users
        </span>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          Add User
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((user) => {
              const { label, color } = getUserRoleDisplay(user);
              return (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={user.image ?? undefined} />
                        <AvatarFallback className="text-xs">
                          {getInitials(user.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="text-sm font-medium">{user.name ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>
                      {label}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {user.department?.name ?? "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {user.isActive ? (
                      <span className="flex items-center gap-1 text-xs text-green-700">
                        <UserCheck className="h-3.5 w-3.5" /> Active
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-600">
                        <UserX className="h-3.5 w-3.5" /> Inactive
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(user.createdAt)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      {user.id !== currentUserId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          title={user.isActive ? "Block user" : "Unblock user"}
                          onClick={() => handleQuickBlock(user)}
                          disabled={blockingId === user.id}
                          className={user.isActive ? "text-orange-500 hover:text-orange-600 hover:bg-orange-50" : "text-green-600 hover:text-green-700 hover:bg-green-50"}
                        >
                          {blockingId === user.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : user.isActive ? (
                            <Ban className="h-3.5 w-3.5" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => openEdit(user)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input placeholder="Jane Smith" value={createName} onChange={(e) => setCreateName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" placeholder="jane@example.com" value={createEmail} onChange={(e) => setCreateEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input type="password" placeholder="Min. 8 characters" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={createRole} onValueChange={(v) => setCreateRole(v as Role)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Department (optional)</Label>
              <Select value={createDept} onValueChange={setCreateDept}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {departments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !createName.trim() || !createEmail.trim() || createPassword.length < 8}
            >
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          {editUser && (
            <div className="space-y-4 py-2">
              <div className="flex items-center gap-3 pb-2 border-b">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={editUser.image ?? undefined} />
                  <AvatarFallback>{getInitials(editUser.name)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">{editUser.name}</p>
                  <p className="text-sm text-muted-foreground">{editUser.email}</p>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={editRoleValue} onValueChange={setEditRoleValue}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" disabled className="text-muted-foreground text-xs font-semibold">
                      — Built-in Roles —
                    </SelectItem>
                    {Object.entries(ROLE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                    {customRoles.filter((cr) => !cr.isBuiltIn).length > 0 && (
                      <>
                        <SelectItem value="__sep__" disabled className="text-muted-foreground text-xs font-semibold">
                          — Custom Roles —
                        </SelectItem>
                        {customRoles
                          .filter((cr) => !cr.isBuiltIn)
                          .map((cr) => (
                            <SelectItem key={cr.id} value={`custom:${cr.id}`}>
                              {cr.name}
                            </SelectItem>
                          ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Department</Label>
                <Select value={editDept} onValueChange={setEditDept}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Business Unit</Label>
                <Select value={editBU} onValueChange={setEditBU}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {businessUnits.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Account Status</Label>
                <Select
                  value={editActive ? "active" : "inactive"}
                  onValueChange={(v) => setEditActive(v === "active")}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive (blocked)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editUser.id !== currentUserId && (
                <div className="pt-3 border-t space-y-2">
                  <p className="text-xs font-medium text-destructive">Danger Zone</p>
                  {!deleteConfirm ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeleteConfirm(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                      Delete User
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Are you sure?</span>
                      <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleting}>
                        {deleting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Delete
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(false)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
