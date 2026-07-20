"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
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
import { Search, Pencil, Loader2, UserCheck, UserX, Plus, Ban, ShieldCheck, Trash2, Link2, X } from "lucide-react";
import { UserDepartmentMemberships, type UserMembership } from "@/components/admin/user-department-memberships";
import { MEMBERSHIP_SOURCE_COLORS } from "@/components/admin/department-role-info";

interface CustomRole { id: string; key: string; name: string; isBuiltIn: boolean }

/** A department-role choice — built-in DepartmentRole enum value or `custom:<CustomRole.id>` — from GET /api/admin/department-roles/options. */
interface DeptRoleOption {
  value: string;
  label: string;
  description?: string;
  isCustom: boolean;
  customRoleId?: string;
}

/** One "Department Memberships" row in the Add User dialog before the user is created. */
interface CreateMembershipRow {
  id: string;
  departmentId: string;
  roleValue: string;
}

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
  microsoftUserId?: string | null;
  lastMicrosoftSyncAt?: string | null;
  departmentMemberships: UserMembership[];
  subDepartmentMemberships?: { id: string; subDepartment: { id: string; name: string } }[];
  globalRoleSource?: "SYSTEM" | "MANUAL" | "MICROSOFT_DEPARTMENT";
  globalRoleUpdatedAt?: string | null;
  globalRoleMicrosoftMapping?: { microsoftValue: string; department: { name: string } } | null;
}

interface Department { id: string; name: string; slug: string }
interface BusinessUnit { id: string; name: string }

interface UserManagementProps {
  users: User[];
  departments: Department[];
  businessUnits: BusinessUnit[];
  currentUserId: string;
  /** "all" or a department id — the server already filtered `users` accordingly; this just drives the Select's displayed value. */
  selectedDepartmentId?: string;
}

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Dept. Manager",
  DIRECTOR: "Director",
  USER: "User",
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_COLORS: Record<Role, string> = {
  ADMIN: "bg-red-100 text-red-700",
  IT_AGENT: "bg-blue-100 text-blue-700",
  DEPARTMENT_MANAGER: "bg-purple-100 text-purple-700",
  DIRECTOR: "bg-indigo-100 text-indigo-700",
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

export function UserManagement({
  users: initialUsers,
  departments,
  businessUnits,
  currentUserId,
  selectedDepartmentId = "all",
}: UserManagementProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [users, setUsers] = useState(initialUsers);
  const [search, setSearch] = useState("");
  const [customRoles, setCustomRoles] = useState<CustomRole[]>([]);

  const [editUser, setEditUser] = useState<User | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editRoleValue, setEditRoleValue] = useState<string>("");
  const [editEmail, setEditEmail] = useState("");
  const [editDept, setEditDept] = useState("");
  const [editBU, setEditBU] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editMemberships, setEditMemberships] = useState<UserMembership[]>([]);

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
  // Repeatable Department Memberships rows — only used once at least one
  // row is added; the single createDept select above covers the common
  // "just one department" case so most Add User flows never need this.
  const [createMemberships, setCreateMemberships] = useState<CreateMembershipRow[]>([]);
  const [createPrimaryRowId, setCreatePrimaryRowId] = useState<string | null>(null);
  const [deptRoleOptions, setDeptRoleOptions] = useState<DeptRoleOption[]>([]);

  useEffect(() => {
    fetch("/api/admin/roles")
      .then((r) => r.json())
      .then((data) => setCustomRoles(data.roles ?? []))
      .catch(() => {});
    fetch("/api/admin/department-roles/options")
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setDeptRoleOptions(Array.isArray(options) ? options : []))
      .catch(() => {});
  }, []);

  /** Resolves a DeptRoleOption.value ("AGENT_ASSIGNEE" or "custom:<id>") into the {role} or {customRoleId} shape the API expects — mirrors the same pattern in department-members-management.tsx. */
  const deptRoleBody = (value: string): { role: string } | { customRoleId: string } => {
    const option = deptRoleOptions.find((o) => o.value === value);
    if (option?.isCustom && option.customRoleId) return { customRoleId: option.customRoleId };
    return { role: value };
  };

  const addMembershipRow = () => {
    const newId = `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCreateMemberships((prev) => [...prev, { id: newId, departmentId: "", roleValue: "" }]);
    setCreatePrimaryRowId((prev) => prev ?? newId);
  };

  const removeMembershipRow = (rowId: string) => {
    setCreateMemberships((prev) => {
      const next = prev.filter((r) => r.id !== rowId);
      setCreatePrimaryRowId((prevPrimary) => (prevPrimary === rowId ? next[0]?.id ?? null : prevPrimary));
      return next;
    });
  };

  const updateMembershipRow = (rowId: string, patch: Partial<Pick<CreateMembershipRow, "departmentId" | "roleValue">>) => {
    setCreateMemberships((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  };

  // Re-sync when the server sends a new `users` prop — e.g. the department
  // filter below changes the URL, the Server Component re-queries, and this
  // client component needs to pick up the new list rather than keep
  // rendering whatever `initialUsers` was on first mount.
  useEffect(() => {
    setUsers(initialUsers);
  }, [initialUsers]);

  const handleDepartmentFilterChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete("departmentId");
    else params.set("departmentId", value);
    router.push(`${pathname}?${params.toString()}`);
  };

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
    if (user.customRole && !user.customRole.key.match(/^(ADMIN|IT_AGENT|DEPARTMENT_MANAGER|DIRECTOR|USER)$/)) {
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
    setCreateMemberships([]);
    setCreatePrimaryRowId(null);
  };

  // Client-side duplicate-department check — defense in depth alongside the
  // server's own rejection; the per-row Department selects already filter
  // out departments used by other rows, so this should rarely trigger.
  const createMembershipDeptIds = createMemberships.map((r) => r.departmentId).filter(Boolean);
  const hasDuplicateCreateDepartments = new Set(createMembershipDeptIds).size !== createMembershipDeptIds.length;
  const createMembershipsIncomplete = createMemberships.some((r) => !r.departmentId || !r.roleValue);

  const handleCreate = async () => {
    if (!createName.trim() || !createEmail.trim() || !createPassword.trim()) return;
    if (hasDuplicateCreateDepartments) {
      toast.error("The same department is selected more than once.");
      return;
    }
    if (createMembershipsIncomplete) {
      toast.error("Choose both a department and a role for every membership row.");
      return;
    }
    setCreating(true);
    try {
      const primaryRow = createMemberships.find((r) => r.id === createPrimaryRowId);
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName,
          email: createEmail,
          password: createPassword,
          role: createRole,
          primaryDepartmentId: primaryRow ? primaryRow.departmentId : (createDept || null),
          departmentMemberships: createMemberships.map((r) => ({
            departmentId: r.departmentId,
            ...deptRoleBody(r.roleValue),
          })),
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
    if (user.customRole && !user.customRole.key.match(/^(ADMIN|IT_AGENT|DEPARTMENT_MANAGER|DIRECTOR|USER)$/)) {
      setEditRoleValue(`custom:${user.customRole.id}`);
    } else {
      setEditRoleValue(user.role);
    }
    setEditEmail(user.email);
    setEditDept(user.department?.id ?? "");
    setEditBU(user.businessUnit?.id ?? "");
    setEditActive(user.isActive);
    setEditMemberships(user.departmentMemberships ?? []);
    setDeleteConfirm(false);
    setEditOpen(true);
  };

  const isEditEmailValid = EMAIL_REGEX.test(editEmail.trim());

  const handleSave = async () => {
    if (!editUser || !isEditEmailValid) return;
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
          email: editEmail.trim(),
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
        <Select value={selectedDepartmentId} onValueChange={handleDepartmentFilterChange}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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
              <TableHead>Departments</TableHead>
              <TableHead>Sub-Departments</TableHead>
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
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium">{user.name ?? "—"}</p>
                          {user.microsoftUserId && (
                            <Link2 className="h-3 w-3 text-blue-600" aria-label="Microsoft-linked" />
                          )}
                        </div>
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
                    {(() => {
                      const active = (user.departmentMemberships ?? []).filter((m) => m.isActive);
                      if (active.length === 0) {
                        return <span className="text-sm text-muted-foreground">—</span>;
                      }
                      const shown = active.slice(0, 3);
                      const extra = active.length - shown.length;
                      return (
                        <div className="flex flex-wrap items-center gap-1">
                          {shown.map((m) => (
                            <span
                              key={m.id}
                              className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full border ${MEMBERSHIP_SOURCE_COLORS[m.source]}`}
                            >
                              {m.department.name}
                            </span>
                          ))}
                          {extra > 0 && (
                            <span className="text-[11px] text-muted-foreground">+{extra} more</span>
                          )}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const subs = user.subDepartmentMemberships ?? [];
                      if (subs.length === 0) {
                        return <span className="text-sm text-muted-foreground">—</span>;
                      }
                      const shown = subs.slice(0, 3);
                      const extra = subs.length - shown.length;
                      return (
                        <div className="flex flex-wrap items-center gap-1">
                          {shown.map((m) => (
                            <span key={m.id} className="text-[11px] font-medium px-1.5 py-0.5 rounded-full border bg-slate-100 text-slate-700 border-slate-200">
                              {m.subDepartment.name}
                            </span>
                          ))}
                          {extra > 0 && (
                            <span className="text-[11px] text-muted-foreground">+{extra} more</span>
                          )}
                        </div>
                      );
                    })()}
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
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:w-full sm:max-w-2xl">
          <DialogHeader className="shrink-0 border-b px-5 py-3 pr-10">
            <DialogTitle>Add User</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <div className="space-y-2">
              <Label>Full Name</Label>
              <Input
                placeholder="Jane Smith"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                autoComplete="off"
                name="new-user-name"
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                placeholder="jane@example.com"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                autoComplete="off"
                name="new-user-email"
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                type="password"
                placeholder="Min. 8 characters"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                autoComplete="new-password"
                name="new-user-password"
              />
            </div>
            <div className="space-y-2">
              <Label>Global Role</Label>
              <Select value={createRole} onValueChange={(v) => setCreateRole(v as Role)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {createMemberships.length === 0 && (
              <div className="space-y-2">
                <Label>Primary Department (optional)</Label>
                <Select value={createDept} onValueChange={setCreateDept}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {createDept
                    ? "Selecting a primary department will also create a Department Membership for this user."
                    : "No primary department selected. A membership can be added later from Department Memberships."}
                </p>
              </div>
            )}

            <div className="space-y-2 pt-3 border-t">
              <div className="flex items-center justify-between">
                <Label>Department Memberships (optional)</Label>
                <Button type="button" size="sm" variant="outline" onClick={addMembershipRow}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add Department
                </Button>
              </div>
              {createMemberships.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Add one or more departments to grant this user a Department Role in each — the first (or the one marked Primary) also becomes their default workspace.
                </p>
              ) : (
                <div className="space-y-2">
                  {createMemberships.map((row) => {
                    const otherUsedIds = createMemberships.filter((r) => r.id !== row.id).map((r) => r.departmentId);
                    const availableDepartments = departments.filter((d) => d.id === row.departmentId || !otherUsedIds.includes(d.id));
                    return (
                      <div key={row.id} className="flex items-start gap-2 rounded-lg border p-2.5">
                        <label className="flex items-center gap-1.5 pt-2 shrink-0" title="Primary department">
                          <input
                            type="radio"
                            name="create-primary-department"
                            checked={createPrimaryRowId === row.id}
                            onChange={() => setCreatePrimaryRowId(row.id)}
                            className="h-3.5 w-3.5"
                          />
                          <span className="text-[11px] text-muted-foreground">Primary</span>
                        </label>
                        <div className="flex-1 grid gap-2 sm:grid-cols-2">
                          <Select value={row.departmentId} onValueChange={(v) => updateMembershipRow(row.id, { departmentId: v })}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Department…" /></SelectTrigger>
                            <SelectContent>
                              {availableDepartments.map((d) => (
                                <SelectItem key={d.id} value={d.id} className="text-xs">{d.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={row.roleValue} onValueChange={(v) => updateMembershipRow(row.id, { roleValue: v })}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Department role…" /></SelectTrigger>
                            <SelectContent>
                              {deptRoleOptions.map((o) => (
                                <SelectItem key={o.value} value={o.value} className="text-xs">
                                  {o.label}{o.isCustom ? " (Custom)" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeMembershipRow(row.id)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                  {hasDuplicateCreateDepartments && (
                    <p className="text-xs text-destructive">The same department is selected more than once.</p>
                  )}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0 gap-2 border-t px-5 py-3">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button
              className="w-full sm:w-auto"
              onClick={handleCreate}
              disabled={
                creating ||
                !createName.trim() ||
                !createEmail.trim() ||
                createPassword.length < 8 ||
                hasDuplicateCreateDepartments ||
                createMembershipsIncomplete
              }
            >
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:w-full sm:max-w-2xl">
          <DialogHeader className="shrink-0 border-b px-5 py-3 pr-10">
            {editUser ? (
              <div className="flex items-center gap-3 min-w-0">
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarImage src={editUser.image ?? undefined} />
                  <AvatarFallback>{getInitials(editUser.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <DialogTitle className="text-base truncate">{editUser.name ?? editUser.email}</DialogTitle>
                  <p className="text-xs text-muted-foreground truncate">{editUser.email}</p>
                </div>
              </div>
            ) : (
              <DialogTitle>Edit User</DialogTitle>
            )}
          </DialogHeader>

          {editUser && (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {/* Global Account */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Global Account</p>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input
                      type="email"
                      className="h-9"
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      aria-invalid={editEmail.length > 0 && !isEditEmailValid}
                      autoComplete="off"
                      name="edit-user-email"
                    />
                    {editEmail.length > 0 && !isEditEmailValid && (
                      <p className="text-xs text-destructive">Enter a valid email address.</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Global Role</Label>
                    <Select
                      value={editRoleValue}
                      onValueChange={setEditRoleValue}
                      disabled={editUser.id === currentUserId}
                    >
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
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

                  <div className="space-y-1.5">
                    <Label className="text-xs">Account Status</Label>
                    <Select
                      value={editActive ? "active" : "inactive"}
                      onValueChange={(v) => setEditActive(v === "active")}
                      disabled={editUser.id === currentUserId}
                    >
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="inactive">Inactive (blocked)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Microsoft</Label>
                    <div className="rounded-md border px-2.5 py-1.5 text-xs bg-muted/30 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">Linked</span>
                        {editUser.microsoftUserId ? (
                          <span className="flex items-center gap-1 text-blue-700 font-medium">
                            <Link2 className="h-3 w-3" /> Yes
                          </span>
                        ) : (
                          <span className="font-medium">No</span>
                        )}
                      </div>
                      {editUser.microsoftUserId && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground shrink-0">User ID</span>
                          <code
                            className="text-[10px] bg-background px-1.5 py-0.5 rounded border truncate max-w-[120px]"
                            title={editUser.microsoftUserId}
                          >
                            {editUser.microsoftUserId}
                          </code>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">Last sync</span>
                        <span className="font-medium truncate">
                          {editUser.lastMicrosoftSyncAt ? formatDateTime(editUser.lastMicrosoftSyncAt) : "Never"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {editUser.id === currentUserId && (
                  <p className="text-xs text-muted-foreground">You cannot change your own role or status.</p>
                )}
                {editUser.globalRoleSource === "MICROSOFT_DEPARTMENT" && (
                  <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-2 py-1.5">
                    Role source: Microsoft Department Mapping
                    {editUser.globalRoleMicrosoftMapping && (
                      <>
                        {" "}({editUser.globalRoleMicrosoftMapping.microsoftValue} → {editUser.globalRoleMicrosoftMapping.department.name})
                      </>
                    )}{" "}
                    — updates automatically on next Microsoft login.
                  </p>
                )}
                {editUser.globalRoleSource === "MANUAL" && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                    Role is manually overridden — Microsoft sync will not change it.
                  </p>
                )}
              </div>

              {/* Primary Department — selecting one also creates/reactivates a real DepartmentMembership (see ensurePrimaryDepartmentMembership) */}
              <div className="space-y-1.5 pt-3 border-t">
                <Label className="text-xs">Primary Department</Label>
                <Select value={editDept} onValueChange={setEditDept}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {editDept ? (
                  <p className="text-xs text-muted-foreground">
                    Selecting a primary department will also create or reactivate a Department Membership for this user.
                    {editDept !== (editUser.department?.id ?? "") && editMemberships.some((m) => m.isActive) && (
                      <> Changing primary department does not remove existing memberships.</>
                    )}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No primary department selected. Existing department memberships are not removed.
                  </p>
                )}
              </div>

              {/* Department Memberships — primary content */}
              <div className="space-y-2 pt-3 border-t">
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Department Memberships</p>
                  <p className="text-xs text-muted-foreground">
                    Department Memberships are the source of truth for access. Primary Department is the default
                    workspace and will ensure a matching membership exists.
                  </p>
                </div>
                <UserDepartmentMemberships
                  userId={editUser.id}
                  memberships={editMemberships}
                  departments={departments}
                  onChange={(updated) => {
                    setEditMemberships(updated);
                    setUsers((prev) =>
                      prev.map((u) => (u.id === editUser.id ? { ...u, departmentMemberships: updated } : u))
                    );
                  }}
                />
              </div>

              {/* Legacy fields — low priority, collapsed by default */}
              <details className="pt-3 border-t">
                <summary className="cursor-pointer text-xs font-semibold text-muted-foreground uppercase tracking-wide select-none">
                  Legacy fields
                </summary>
                <div className="mt-3 space-y-1.5">
                  <Label className="text-xs">Business Unit</Label>
                  <Select value={editBU} onValueChange={setEditBU}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">None</SelectItem>
                      {businessUnits.map((b) => (
                        <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </details>

              {/* Danger Zone — collapsed by default, kept out of the normal edit flow */}
              {editUser.id !== currentUserId && (
                <details className="pt-3 border-t">
                  <summary className="cursor-pointer text-xs font-medium text-destructive select-none">
                    Danger Zone
                  </summary>
                  <div className="mt-2">
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
                </details>
              )}
            </div>
          )}

          <DialogFooter className="shrink-0 gap-2 border-t px-5 py-3">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving || !isEditEmailValid}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
