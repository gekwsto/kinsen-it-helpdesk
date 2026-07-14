"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";

interface DepartmentSettingsFormProps {
  department: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isActive: boolean;
  };
  /** Activate/deactivate is a structural, System-Admin-only action (see Phase 3 plan) — hidden for Department Admins. */
  canToggleActive: boolean;
}

export function DepartmentSettingsForm({ department, canToggleActive }: DepartmentSettingsFormProps) {
  const router = useRouter();
  const [name, setName] = useState(department.name);
  const [slug, setSlug] = useState(department.slug);
  const [description, setDescription] = useState(department.description ?? "");
  const [isActive, setIsActive] = useState(department.isActive);
  const [saving, setSaving] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/departments/${department.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          slug,
          description: description.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update department");
      }
      toast.success("Department updated");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update department");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    const next = !isActive;
    setTogglingActive(true);
    try {
      const res = await fetch(`/api/admin/departments/${department.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update department");
      }
      setIsActive(next);
      toast.success(next ? "Department activated" : "Department deactivated");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update department");
    } finally {
      setTogglingActive(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Slug</Label>
          <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
          <p className="text-xs text-muted-foreground">Lowercase letters, numbers and hyphens only.</p>
        </div>
        <div className="space-y-2">
          <Label>Description</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>

        {canToggleActive && (
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">
                Inactive departments can&apos;t be selected as an active workspace by non-admin users.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {togglingActive && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <Switch checked={isActive} onCheckedChange={handleToggleActive} disabled={togglingActive} />
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || !name.trim() || !slug.trim()}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
