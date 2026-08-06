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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { BusinessUnitCombobox, type BusinessUnitOption } from "@/components/admin/business-unit-combobox";

interface DepartmentSettingsFormProps {
  department: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isActive: boolean;
    businessUnitId: string | null;
  };
  /** Activate/deactivate is a structural, System-Admin-only action (see Phase 3 plan) — hidden for Department Admins. */
  canToggleActive: boolean;
  /**
   * Business Unit reassignment requires the stronger global department.update
   * AND businessUnit.update permissions (see app/api/admin/departments/[id]/route.ts)
   * — a department.manageSettings grant alone (which can be department-scoped)
   * isn't enough, since this changes the whole organizational ancestry, not
   * just this department's own settings. `businessUnits` is only fetched/passed
   * by the server page when this is true.
   */
  canChangeBusinessUnit: boolean;
  businessUnits: BusinessUnitOption[];
}

export function DepartmentSettingsForm({ department, canToggleActive, canChangeBusinessUnit, businessUnits }: DepartmentSettingsFormProps) {
  const router = useRouter();
  const [name, setName] = useState(department.name);
  const [slug, setSlug] = useState(department.slug);
  const [description, setDescription] = useState(department.description ?? "");
  const [isActive, setIsActive] = useState(department.isActive);
  const [businessUnitId, setBusinessUnitId] = useState(department.businessUnitId ?? "");
  const [saving, setSaving] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [confirmCrossCompanyOpen, setConfirmCrossCompanyOpen] = useState(false);

  const currentBusinessUnit = businessUnits.find((bu) => bu.id === department.businessUnitId) ?? null;
  const selectedBusinessUnit = businessUnits.find((bu) => bu.id === businessUnitId) ?? null;
  const isCrossCompanyMove =
    canChangeBusinessUnit &&
    businessUnitId !== department.businessUnitId &&
    !!selectedBusinessUnit &&
    !!currentBusinessUnit &&
    selectedBusinessUnit.company.id !== currentBusinessUnit.company.id;

  const doSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        slug,
        description: description.trim() || null,
      };
      if (canChangeBusinessUnit && businessUnitId !== department.businessUnitId) {
        body.businessUnitId = businessUnitId;
      }
      const res = await fetch(`/api/admin/departments/${department.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  const handleSave = async () => {
    if (isCrossCompanyMove) {
      setConfirmCrossCompanyOpen(true);
      return;
    }
    await doSave();
  };

  const handleConfirmCrossCompanyMove = async () => {
    setConfirmCrossCompanyOpen(false);
    await doSave();
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

        {canChangeBusinessUnit && (
          <div className="space-y-2">
            <Label>Business Unit</Label>
            <BusinessUnitCombobox businessUnits={businessUnits} value={businessUnitId} onChange={setBusinessUnitId} disabled={saving} />
            {!businessUnitId && (
              <p className="text-xs text-destructive">A department must belong to a business unit.</p>
            )}
            {isCrossCompanyMove && (
              <p className="text-xs text-amber-600">
                This moves the department to a business unit under a different company.
              </p>
            )}
          </div>
        )}

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
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim() || !slug.trim() || (canChangeBusinessUnit && !businessUnitId)}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirmCrossCompanyOpen} onOpenChange={setConfirmCrossCompanyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move department to a different company?</DialogTitle>
            <DialogDescription>
              {currentBusinessUnit && selectedBusinessUnit && (
                <>
                  This department is moving from <strong>{currentBusinessUnit.name}</strong> ({currentBusinessUnit.company.name}) to{" "}
                  <strong>{selectedBusinessUnit.name}</strong> ({selectedBusinessUnit.company.name}) — a different company. This changes the
                  department&apos;s entire organizational ancestry. Users, tickets, projects, and Microsoft mappings stay linked to this
                  department; only its place in the organization tree changes.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCrossCompanyOpen(false)}>Cancel</Button>
            <Button onClick={handleConfirmCrossCompanyMove} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Confirm Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
