"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Plus, Pencil, Trash2, ShieldCheck, Shield, Ban, RotateCcw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type RoleScope = "GLOBAL" | "DEPARTMENT" | "BOTH";

interface CustomRole {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  isBuiltIn: boolean;
  isActive: boolean;
  scope: RoleScope;
}

interface Permission {
  id: string;
  key: string;
  description?: string | null;
  module: string;
}

interface RolePermission {
  roleKey: string;
  permissionId: string;
}

const MODULE_LABELS: Record<string, string> = {
  tickets: "Tickets",
  projects: "Projects",
  activities: "Activities",
  goals: "Goals",
  admin: "Administration",
  department: "Department",
};

// Global-role-only permissions — the permission-grant route also rejects
// these server-side for DEPARTMENT/BOTH-scope roles (defense in depth, not
// just a UI hint); department-scoped roles can never reach system
// administration this way.
const GLOBAL_ONLY_PERMISSION_KEYS = new Set(["admin.access", "user.manage", "role.manage"]);

export default function RolesAdminPage() {
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [rolePerms, setRolePerms] = useState<Set<string>>(new Set());
  const [selectedRole, setSelectedRole] = useState<CustomRole | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"global" | "department">("global");

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<CustomRole | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Disable confirm (built-in roles use this instead of hard delete)
  const [disableTarget, setDisableTarget] = useState<CustomRole | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disabling, setDisabling] = useState(false);

  // Remove permission confirm
  const [removePermTarget, setRemovePermTarget] = useState<Permission | null>(null);
  const [removePermOpen, setRemovePermOpen] = useState(false);
  const [removingPerm, setRemovingPerm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/roles");
      const data = await res.json();
      setRoles(data.roles ?? []);
      setPermissions(data.permissions ?? []);
      const set = new Set<string>(
        (data.rolePermissions ?? []).map((rp: RolePermission) => `${rp.roleKey}:${rp.permissionId}`)
      );
      setRolePerms(set);
      if (!selectedRole && data.roles?.length > 0) {
        const firstGlobal = (data.roles as CustomRole[]).find((r) => r.scope !== "DEPARTMENT");
        setSelectedRole(firstGlobal ?? data.roles[0]);
      }
    } catch {
      toast.error("Failed to load roles");
    } finally {
      setLoading(false);
    }
  }, [selectedRole]);

  useEffect(() => { load(); }, []);

  const isAssigned = (role: CustomRole, permId: string) =>
    rolePerms.has(`${role.key}:${permId}`);

  const togglePerm = (perm: Permission) => {
    if (!selectedRole) return;
    const assigned = isAssigned(selectedRole, perm.id);
    if (assigned) {
      setRemovePermTarget(perm);
      setRemovePermOpen(true);
    } else {
      addPerm(perm);
    }
  };

  const addPerm = async (perm: Permission) => {
    if (!selectedRole) return;
    const key = `${selectedRole.key}:${perm.id}`;
    setToggling(key);
    try {
      const res = await fetch(`/api/admin/roles/${selectedRole.id}/permissions/${perm.id}`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update permission");
      }
      setRolePerms((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update permission");
    } finally {
      setToggling(null);
    }
  };

  const handleRemovePerm = async () => {
    if (!selectedRole || !removePermTarget) return;
    const key = `${selectedRole.key}:${removePermTarget.id}`;
    setRemovingPerm(true);
    setToggling(key);
    try {
      const res = await fetch(
        `/api/admin/roles/${selectedRole.id}/permissions/${removePermTarget.id}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to remove permission");
      }
      setRolePerms((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setRemovePermOpen(false);
      setRemovePermTarget(null);
      toast.success("Permission removed");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to remove permission");
    } finally {
      setRemovingPerm(false);
      setToggling(null);
    }
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createName,
          description: createDesc || undefined,
          scope: activeTab === "global" ? "GLOBAL" : "DEPARTMENT",
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create role");
      }
      const newRole = await res.json();
      setRoles((prev) => [...prev, newRole]);
      setSelectedRole(newRole);
      setCreateOpen(false);
      setCreateName("");
      setCreateDesc("");
      toast.success("Role created");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to create role");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (role: CustomRole) => {
    setEditingRole(role);
    setEditName(role.name);
    setEditDesc(role.description ?? "");
    setEditOpen(true);
  };

  const handleEdit = async () => {
    if (!editingRole || !editName.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/roles/${editingRole.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, description: editDesc || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update role");
      }
      const updated = await res.json();
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      if (selectedRole?.id === updated.id) setSelectedRole(updated);
      setEditOpen(false);
      toast.success("Role updated");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update role");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/roles/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error ?? "Failed to delete role");
        if (res.status === 409) return; // keep dialog open so user reads the message
        return;
      }
      const remaining = roles.filter((r) => r.id !== deleteTarget.id);
      setRoles(remaining);
      if (selectedRole?.id === deleteTarget.id) {
        setSelectedRole(remaining[0] ?? null);
      }
      setDeleteOpen(false);
      setDeleteTarget(null);
      toast.success("Role deleted");
    } catch {
      toast.error("Failed to delete role");
    } finally {
      setDeleting(false);
    }
  };

  // Built-in roles can never be hard-deleted (their key is referenced
  // elsewhere by hardcoded lookups) — Disable is the lever instead, guarded
  // server-side against orphaning the last path to admin access. Re-enabling
  // carries no such risk, so it skips the confirm dialog.
  const handleToggleActive = async (role: CustomRole, nextActive: boolean) => {
    setDisabling(true);
    try {
      const res = await fetch(`/api/admin/roles/${role.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: nextActive }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update role");
      }
      const updated = await res.json();
      setRoles((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      if (selectedRole?.id === updated.id) setSelectedRole(updated);
      setDisableOpen(false);
      setDisableTarget(null);
      toast.success(nextActive ? "Role enabled" : "Role disabled");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to update role");
    } finally {
      setDisabling(false);
    }
  };

  const modules = [...new Set(permissions.map((p) => p.module))].sort();

  // DEPARTMENT_MANAGER (scope BOTH) intentionally appears on both tabs — it's
  // one shared roleKey for the global Role.DEPARTMENT_MANAGER and
  // DepartmentRole.DEPARTMENT_MANAGER, not two separate roles.
  const globalRoles = roles.filter((r) => r.scope !== "DEPARTMENT");
  const departmentRoles = roles.filter((r) => r.scope !== "GLOBAL");
  const visibleRoles = activeTab === "global" ? globalRoles : departmentRoles;

  const switchTab = (tab: "global" | "department") => {
    setActiveTab(tab);
    const list = tab === "global" ? globalRoles : departmentRoles;
    if (!selectedRole || !list.some((r) => r.id === selectedRole.id)) {
      setSelectedRole(list[0] ?? null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Roles & Permissions</h1>
        <p className="text-muted-foreground mt-1">
          Manage roles and configure their permissions. Built-in roles can be renamed and
          have permissions changed, but use Disable instead of Delete.
        </p>
      </div>

      {/* Global Roles / Department Roles tabs */}
      <div className="flex items-center gap-1 border-b">
        <button
          onClick={() => switchTab("global")}
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            activeTab === "global"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Global Roles
        </button>
        <button
          onClick={() => switchTab("department")}
          className={cn(
            "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
            activeTab === "department"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          Department Roles
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        {/* Role list */}
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-muted-foreground">
              {activeTab === "global" ? "Global Roles" : "Department Roles"}
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Role
            </Button>
          </div>

          {visibleRoles.map((role) => (
            <div
              key={role.id}
              onClick={() => setSelectedRole(role)}
              className={cn(
                "flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors group",
                selectedRole?.id === role.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "hover:bg-muted/50"
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                {role.isBuiltIn ? (
                  <ShieldCheck className={cn("h-4 w-4 flex-shrink-0", selectedRole?.id === role.id ? "text-primary-foreground" : "text-muted-foreground")} />
                ) : (
                  <Shield className={cn("h-4 w-4 flex-shrink-0", selectedRole?.id === role.id ? "text-primary-foreground" : "text-muted-foreground")} />
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium truncate">{role.name}</p>
                    <span
                      className={cn(
                        "shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                        selectedRole?.id === role.id
                          ? "bg-primary-foreground/20 text-primary-foreground"
                          : role.isBuiltIn
                          ? "bg-slate-100 text-slate-600"
                          : "bg-teal-100 text-teal-700"
                      )}
                    >
                      {role.isBuiltIn ? "Built-in" : "Custom"}
                    </span>
                    {!role.isActive && (
                      <span
                        className={cn(
                          "shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                          selectedRole?.id === role.id
                            ? "bg-primary-foreground/20 text-primary-foreground"
                            : "bg-amber-100 text-amber-700"
                        )}
                      >
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className={cn("text-xs truncate", selectedRole?.id === role.id ? "text-primary-foreground/70" : "text-muted-foreground")}>
                    {role.key} · {role.scope}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); openEdit(role); }}
                  title="Edit role"
                  className={cn(
                    "p-1 rounded transition-colors hover:bg-black/10",
                    selectedRole?.id === role.id ? "text-primary-foreground" : "text-muted-foreground"
                  )}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {role.isBuiltIn ? (
                  role.isActive ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDisableTarget(role); setDisableOpen(true); }}
                      title="Disable role — blocked if it would remove the last path to admin access"
                      className={cn(
                        "p-1 rounded transition-colors hover:bg-amber-100 text-amber-600",
                        selectedRole?.id === role.id && "text-primary-foreground hover:text-amber-600"
                      )}
                    >
                      <Ban className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleActive(role, true); }}
                      disabled={disabling}
                      title="Enable role"
                      className={cn(
                        "p-1 rounded transition-colors hover:bg-emerald-100 text-emerald-600",
                        selectedRole?.id === role.id && "text-primary-foreground hover:text-emerald-600"
                      )}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(role); setDeleteOpen(true); }}
                    title="Delete role"
                    className={cn(
                      "p-1 rounded transition-colors hover:bg-red-100 text-red-500",
                      selectedRole?.id === role.id && "text-primary-foreground hover:text-red-500"
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Permission matrix */}
        <div>
          {!selectedRole ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                Select a role to manage its permissions.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-base">{selectedRole.name}</CardTitle>
                      {selectedRole.description && (
                        <p className="text-sm text-muted-foreground mt-1">{selectedRole.description}</p>
                      )}
                      {selectedRole.scope === "BOTH" && (
                        <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-md px-2 py-1 mt-2 inline-block">
                          Shared with the global Department Manager role — editing permissions here affects both.
                        </p>
                      )}
                    </div>
                    {selectedRole.key === "ADMIN" && (
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                        Full Access
                      </span>
                    )}
                  </div>
                </CardHeader>
              </Card>

              {selectedRole.key === "ADMIN" && (
                <Card className="border-amber-200 bg-amber-50">
                  <CardContent className="py-3 flex items-start gap-2 text-sm text-amber-800">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <p>
                      Changing Administrator permissions can affect system access. Safety checks
                      prevent removing the last path to admin access.
                    </p>
                  </CardContent>
                </Card>
              )}
              {
                modules.map((module) => {
                  const modulePerms = permissions.filter((p) => p.module === module);
                  const assignedCount = modulePerms.filter((p) => isAssigned(selectedRole, p.id)).length;
                  const hasAssignablePerm = modulePerms.some((p) => p.key.endsWith(".assignable"));
                  return (
                    <Card key={module}>
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-sm capitalize">
                            {MODULE_LABELS[module] ?? module}
                          </CardTitle>
                          <span className="text-xs text-muted-foreground">
                            {assignedCount}/{modulePerms.length}
                          </span>
                        </div>
                        {hasAssignablePerm && (
                          <p className="text-xs text-muted-foreground pt-1">
                            &quot;Can be assigned to…&quot; permissions control whether users with this role appear in
                            assignee dropdowns — separate from being able to assign others.
                          </p>
                        )}
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {modulePerms.map((perm) => {
                            const assigned = isAssigned(selectedRole, perm.id);
                            const key = `${selectedRole.key}:${perm.id}`;
                            const restricted = selectedRole.scope !== "GLOBAL" && GLOBAL_ONLY_PERMISSION_KEYS.has(perm.key);
                            return (
                              <label
                                key={perm.id}
                                className={cn(
                                  "flex items-center gap-3 p-2 rounded-lg transition-colors",
                                  restricted ? "opacity-50 cursor-not-allowed" : "hover:bg-muted/50 cursor-pointer"
                                )}
                              >
                                {toggling === key ? (
                                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
                                ) : (
                                  <input
                                    type="checkbox"
                                    checked={assigned}
                                    disabled={restricted}
                                    onChange={() => togglePerm(perm)}
                                    className="h-4 w-4 rounded flex-shrink-0 cursor-pointer disabled:cursor-not-allowed"
                                  />
                                )}
                                <div className="min-w-0">
                                  <p className="text-sm font-medium">
                                    {perm.key}
                                    {perm.key.endsWith(".assignable") && (
                                      <span className="ml-1.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full align-middle">
                                        Assignable
                                      </span>
                                    )}
                                  </p>
                                  {perm.description && (
                                    <p className="text-xs text-muted-foreground">{perm.description}</p>
                                  )}
                                  {restricted && (
                                    <p className="text-xs text-amber-700">System administration — Administrator only.</p>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              }
            </div>
          )}
        </div>
      </div>

      {/* Create Role Dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) { setCreateName(""); setCreateDesc(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeTab === "global" ? "Create New Global Role" : "Create New Department Role"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">
              {activeTab === "global"
                ? "A system-wide role, alongside Administrator, IT Agent, Director and User."
                : "A department-scoped role — assignable to a user's DepartmentMembership, alongside the built-in Department Admin, Department Manager, Project Manager, Agent/Assignee, Requester and Viewer roles."}
            </p>
            <div className="space-y-2">
              <Label htmlFor="create-name">Role Name *</Label>
              <Input
                id="create-name"
                placeholder={activeTab === "global" ? "e.g. Support Manager" : "e.g. Field Technician"}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />
              {createName && (
                <p className="text-xs text-muted-foreground">
                  Key: {createName.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "")}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-desc">Description</Label>
              <Textarea
                id="create-desc"
                placeholder="What can this role do?"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Role</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Role Name *</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea
                id="edit-desc"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving || !editName.trim()}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Role</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>?
              All permission assignments will be removed and users will be unassigned from this role.
              This action cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable Confirm Dialog (built-in roles use Disable instead of Delete) */}
      <Dialog open={disableOpen} onOpenChange={(o) => { setDisableOpen(o); if (!o) setDisableTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable Role</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <p className="text-sm text-muted-foreground">
              Are you sure you want to disable <strong>{disableTarget?.name}</strong>?
              It will no longer be offered when assigning department roles. This is blocked if it
              would remove the last path to admin access.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisableOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => disableTarget && handleToggleActive(disableTarget, false)}
              disabled={disabling}
            >
              {disabling && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Disable Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Permission Confirm Dialog */}
      <Dialog
        open={removePermOpen}
        onOpenChange={(o) => {
          setRemovePermOpen(o);
          if (!o) setRemovePermTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Permission</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2">
            <p className="text-sm text-muted-foreground">
              You are about to remove the permission{" "}
              <strong className="text-foreground">{removePermTarget?.key}</strong> from the role{" "}
              <strong className="text-foreground">{selectedRole?.name}</strong>.
            </p>
            <p className="text-sm text-muted-foreground">
              Users with this role will lose access to this action immediately.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovePermOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRemovePerm} disabled={removingPerm}>
              {removingPerm && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remove Permission
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
