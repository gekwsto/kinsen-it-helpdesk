"use client";

import { useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatRelative } from "@/lib/utils";
import { Plus, Loader2, KeyRound, Copy, Check, AlertTriangle, Plug } from "lucide-react";

interface CategoryOption { id: string; name: string }
interface PriorityOption { id: string; name: string }
interface DepartmentOption {
  id: string;
  name: string;
  categories: CategoryOption[];
  priorities: PriorityOption[];
}

interface IntegrationRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  departmentId: string;
  department: { id: string; name: string };
  defaultCategoryId: string | null;
  defaultCategory: { id: string; name: string } | null;
  defaultPriorityId: string | null;
  defaultPriority: { id: string; name: string } | null;
  baseUrl: string | null;
  apiKeyPrefix: string;
  lastUsedAt: string | null;
  createdBy: { id: string; name: string | null; email: string } | null;
  createdAt: string;
  _count: { tickets: number };
}

interface IntegrationManagementProps {
  integrations: IntegrationRow[];
  departments: DepartmentOption[];
}

interface FormState {
  name: string;
  departmentId: string;
  defaultCategoryId: string;
  defaultPriorityId: string;
  baseUrl: string;
}

const EMPTY_FORM: FormState = { name: "", departmentId: "", defaultCategoryId: "", defaultPriorityId: "", baseUrl: "" };

export function IntegrationManagement({ integrations: initialIntegrations, departments }: IntegrationManagementProps) {
  const router = useRouter();
  const [integrations, setIntegrations] = useState(initialIntegrations);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);

  const [editTarget, setEditTarget] = useState<IntegrationRow | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<IntegrationRow | null>(null);
  const [rotating, setRotating] = useState(false);

  const [revealKey, setRevealKey] = useState<{ integrationName: string; apiKey: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const departmentById = useMemo(() => new Map(departments.map((d) => [d.id, d])), [departments]);

  const resetCreate = () => setCreateForm(EMPTY_FORM);

  const handleCreate = async () => {
    if (!createForm.name.trim() || !createForm.departmentId) return;
    setCreating(true);
    try {
      const res = await fetch("/api/admin/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createForm.name.trim(),
          departmentId: createForm.departmentId,
          defaultCategoryId: createForm.defaultCategoryId || undefined,
          defaultPriorityId: createForm.defaultPriorityId || undefined,
          baseUrl: createForm.baseUrl.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? body.error ?? "Failed to create integration");

      setIntegrations((prev) => [body.integration, ...prev]);
      setCreateOpen(false);
      resetCreate();
      setRevealKey({ integrationName: body.integration.name, apiKey: body.apiKey });
      setCopied(false);
      toast.success("Integration created");
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create integration");
    } finally {
      setCreating(false);
    }
  };

  const openEdit = (integration: IntegrationRow) => {
    setEditTarget(integration);
    setEditForm({
      name: integration.name,
      departmentId: integration.departmentId,
      defaultCategoryId: integration.defaultCategoryId ?? "",
      defaultPriorityId: integration.defaultPriorityId ?? "",
      baseUrl: integration.baseUrl ?? "",
    });
  };

  const handleSaveEdit = async () => {
    if (!editTarget) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/integrations/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          departmentId: editForm.departmentId,
          defaultCategoryId: editForm.defaultCategoryId || null,
          defaultPriorityId: editForm.defaultPriorityId || null,
          baseUrl: editForm.baseUrl.trim() || null,
        }),
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.message ?? updated.error ?? "Failed to update integration");

      setIntegrations((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
      toast.success("Integration updated");
      setEditTarget(null);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update integration");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (integration: IntegrationRow) => {
    setTogglingId(integration.id);
    try {
      const res = await fetch(`/api/admin/integrations/${integration.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !integration.isActive }),
      });
      const updated = await res.json();
      if (!res.ok) throw new Error(updated.message ?? updated.error ?? "Failed to update integration");
      setIntegrations((prev) => prev.map((i) => (i.id === integration.id ? updated : i)));
      toast.success(integration.isActive ? "Integration disabled" : "Integration enabled");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update integration");
    } finally {
      setTogglingId(null);
    }
  };

  const handleRotate = async () => {
    if (!rotateTarget) return;
    setRotating(true);
    try {
      const res = await fetch(`/api/admin/integrations/${rotateTarget.id}/rotate`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? body.error ?? "Failed to rotate API key");

      setIntegrations((prev) => prev.map((i) => (i.id === rotateTarget.id ? { ...i, apiKeyPrefix: body.integration.apiKeyPrefix, lastUsedAt: null } : i)));
      setRotateTarget(null);
      setRevealKey({ integrationName: body.integration.name, apiKey: body.apiKey });
      setCopied(false);
      toast.success("API key rotated — the previous key no longer works");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to rotate API key");
    } finally {
      setRotating(false);
    }
  };

  const copyKey = async () => {
    if (!revealKey) return;
    await navigator.clipboard.writeText(revealKey.apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderDepartmentFields = (form: FormState, setForm: (f: FormState) => void) => {
    const dept = departmentById.get(form.departmentId);
    return (
      <>
        <div className="space-y-2">
          <Label>Department</Label>
          <Select
            value={form.departmentId}
            onValueChange={(value) => setForm({ ...form, departmentId: value, defaultCategoryId: "", defaultPriorityId: "" })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a department" />
            </SelectTrigger>
            <SelectContent>
              {departments.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Every ticket this integration creates lives in this department — the request can never override it.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Default Category (optional)</Label>
            <Select
              value={form.defaultCategoryId || "__none__"}
              onValueChange={(value) => setForm({ ...form, defaultCategoryId: value === "__none__" ? "" : value })}
              disabled={!dept}
            >
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {dept?.categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Default Priority (optional)</Label>
            <Select
              value={form.defaultPriorityId || "__none__"}
              onValueChange={(value) => setForm({ ...form, defaultPriorityId: value === "__none__" ? "" : value })}
              disabled={!dept}
            >
              <SelectTrigger>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">None</SelectItem>
                {dept?.priorities.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{integrations.length} integration{integrations.length !== 1 ? "s" : ""}</span>
        <Button onClick={() => setCreateOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          New Integration
        </Button>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Integration</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>API Key</TableHead>
              <TableHead>Tickets</TableHead>
              <TableHead>Last Used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {integrations.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-10">
                  <Plug className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  No integrations yet — create one to let another application submit tickets.
                </TableCell>
              </TableRow>
            )}
            {integrations.map((integration) => (
              <TableRow key={integration.id}>
                <TableCell>
                  <p className="text-sm font-medium">{integration.name}</p>
                  <p className="text-xs text-muted-foreground">{integration.slug}</p>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{integration.department.name}</span>
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{integration.apiKeyPrefix}…</code>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-muted-foreground">{integration._count.tickets}</span>
                </TableCell>
                <TableCell>
                  <span className="text-xs text-muted-foreground">
                    {integration.lastUsedAt ? formatRelative(new Date(integration.lastUsedAt)) : "Never"}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={integration.isActive}
                      onCheckedChange={() => handleToggleActive(integration)}
                      disabled={togglingId === integration.id}
                    />
                    <span className={`text-xs font-medium ${integration.isActive ? "text-green-700" : "text-muted-foreground"}`}>
                      {togglingId === integration.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : integration.isActive ? (
                        "Active"
                      ) : (
                        "Disabled"
                      )}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(integration)}>Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRotateTarget(integration)} title="Rotate API key">
                      <KeyRound className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Integration</DialogTitle>
            <DialogDescription>
              Issues a server-to-server API key another application uses to create tickets via POST /api/integrations/tickets.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="Vehicle Management App" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            </div>
            {renderDepartmentFields(createForm, setCreateForm)}
            <div className="space-y-2">
              <Label>Base URL (optional)</Label>
              <Input
                placeholder="https://vehicles.example.com"
                value={createForm.baseUrl}
                onChange={(e) => setCreateForm({ ...createForm, baseUrl: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                When set, every ticket&apos;s sourceUrl must share this exact origin.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); resetCreate(); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={creating || !createForm.name.trim() || !createForm.departmentId}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Integration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Integration</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            {renderDepartmentFields(editForm, setEditForm)}
            <div className="space-y-2">
              <Label>Base URL (optional)</Label>
              <Input
                placeholder="https://vehicles.example.com"
                value={editForm.baseUrl}
                onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editForm.name.trim() || !editForm.departmentId}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate confirm dialog */}
      <Dialog open={!!rotateTarget} onOpenChange={(open) => { if (!open) setRotateTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate API Key</DialogTitle>
            <DialogDescription>
              This immediately invalidates {rotateTarget?.name}&apos;s current API key. Any application still using the old key will start getting 401 errors until it&apos;s updated with the new one.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleRotate} disabled={rotating}>
              {rotating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Rotate Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raw key reveal dialog — the only place the raw key is ever shown */}
      <Dialog open={!!revealKey} onOpenChange={(open) => { if (!open) setRevealKey(null); }}>
        <DialogContent onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>API Key for {revealKey?.integrationName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-lg border border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 p-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 dark:text-amber-300">
                Copy this key now — it will not be shown again. Store it as a server-side secret only (e.g. an environment variable in the calling application&apos;s backend), never in client-side code.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted px-3 py-2 rounded border break-all font-mono">{revealKey?.apiKey}</code>
              <Button size="sm" variant="outline" onClick={copyKey}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
