"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

type RoleScope = "GLOBAL" | "DEPARTMENT" | "BOTH";

interface CustomRole {
  id: string;
  key: string;
  name: string;
  isBuiltIn: boolean;
  isActive: boolean;
  scope: RoleScope;
}

interface DefaultRoleConfigView {
  defaultGlobalCustomRole: { id: string; name: string } | null;
  defaultDepartmentCustomRole: { id: string; name: string } | null;
}

const NONE_VALUE = "__none__";

/**
 * Admin UI for the two configurable defaults: which CustomRole a
 * newly-provisioned user (Default Global Role) / newly-created
 * DepartmentMembership (Default Department Role) gets when no explicit
 * Microsoft mapping applies — see lib/services/default-role-service.ts.
 * `roles` is the SAME CustomRole list app/(main)/admin/roles/page.tsx
 * already fetches for the tabs below (GET /api/admin/roles) — no separate
 * fetch for the picker options, only for the current config value itself
 * (GET /api/admin/default-roles, a tiny singleton read).
 */
export function DefaultRolesConfig({ roles }: { roles: CustomRole[] }) {
  const [config, setConfig] = useState<DefaultRoleConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savingDepartment, setSavingDepartment] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/default-roles");
        if (!res.ok) throw new Error("Failed to load default roles");
        setConfig(await res.json());
      } catch {
        toast.error("Failed to load default roles");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Only active roles are offered as a NEW default — an already-configured
  // but since-deactivated role (shouldn't normally happen, the
  // deletion/deactivation guard prevents it, but defense in depth) is still
  // shown as the current value via the synthetic entry below, exactly like
  // the disabled-role display pattern elsewhere in this admin surface.
  const globalOptions = roles.filter((r) => r.scope !== "DEPARTMENT" && r.isActive);
  const departmentOptions = roles.filter((r) => r.scope !== "GLOBAL" && r.isActive);

  function optionsFor(kind: "global" | "department", current: { id: string; name: string } | null) {
    const base = kind === "global" ? globalOptions : departmentOptions;
    if (!current || base.some((r) => r.id === current.id)) return base;
    return [{ id: current.id, name: `${current.name} (disabled)`, key: current.id, isBuiltIn: false, isActive: false, scope: "BOTH" as RoleScope }, ...base];
  }

  async function save(field: "defaultGlobalCustomRoleId" | "defaultDepartmentCustomRoleId", value: string) {
    const setSaving = field === "defaultGlobalCustomRoleId" ? setSavingGlobal : setSavingDepartment;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/default-roles", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [field]: value === NONE_VALUE ? null : value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setConfig(data);
      toast.success("Default role updated");
    } catch (e: any) {
      toast.error(e.message ?? "Failed to save default role");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Default Roles</CardTitle>
        <p className="text-sm text-muted-foreground">
          The role a newly-provisioned user or department membership gets when no
          explicit Microsoft mapping applies. Never affects an existing manual
          assignment or a prior Microsoft-mapping-derived role.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Default Global Role</label>
          <Select
            value={config?.defaultGlobalCustomRole?.id ?? NONE_VALUE}
            onValueChange={(v) => save("defaultGlobalCustomRoleId", v)}
            disabled={savingGlobal}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>None</SelectItem>
              {optionsFor("global", config?.defaultGlobalCustomRole ?? null).map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Default Department Role</label>
          <Select
            value={config?.defaultDepartmentCustomRole?.id ?? NONE_VALUE}
            onValueChange={(v) => save("defaultDepartmentCustomRoleId", v)}
            disabled={savingDepartment}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>None</SelectItem>
              {optionsFor("department", config?.defaultDepartmentCustomRole ?? null).map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
