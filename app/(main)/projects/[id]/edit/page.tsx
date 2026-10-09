"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronRight, Loader2 } from "lucide-react";
import { ProjectStatus } from "@prisma/client";

interface AssignableUser {
  id: string;
  name: string | null;
  email: string;
}

interface SubDepartmentOption {
  id: string;
  name: string;
}

interface ExpenseTypeOption {
  id: string;
  name: string;
}

export default function EditProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<ProjectStatus>(ProjectStatus.PLANNING);
  const [priority, setPriority] = useState("2");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [successTarget, setSuccessTarget] = useState("");
  const [isGoal, setIsGoal] = useState(false);
  const [subDepartments, setSubDepartments] = useState<SubDepartmentOption[]>([]);
  const [subDepartmentId, setSubDepartmentId] = useState("");

  // Request-origin-only — only ever shown/editable when the Project was
  // actually created through the request-origin setup flow (projectRequestId
  // set). A legacy request-origin Project (from before this feature, or
  // with these left null) is still editable like any other — these fields
  // simply start blank/unset, never a validation blocker.
  const [projectRequestId, setProjectRequestId] = useState<string | null>(null);
  // Creation-time baseline — display-only, server-authoritative, never sent
  // back on PATCH (see updateProjectRequestOriginFieldsSchema's doc comment
  // in lib/validations.ts). Editing Expected Start/Finish below must never
  // recompute or overwrite this; there is simply no code path that does.
  const [expectedTotalInitialDays, setExpectedTotalInitialDays] = useState<number | null>(null);
  const [expectedStartDate, setExpectedStartDate] = useState("");
  const [expectedFinishDate, setExpectedFinishDate] = useState("");
  const [expenseTypeId, setExpenseTypeId] = useState("");
  // Not stored — Project.budget/estimatedCost/actualCost no longer exist as
  // DB columns. These are derived totals computed server-side (GET
  // /api/projects/[id] via withProjectFinancials) from this Project's
  // Activities, displayed readonly, and never sent back on PATCH.
  const [estimatedCost, setEstimatedCost] = useState("");
  const [actualCost, setActualCost] = useState("");
  const [external, setExternal] = useState(false);
  const [expenseTypes, setExpenseTypes] = useState<ExpenseTypeOption[]>([]);

  useEffect(() => {
    fetch(`/api/projects/${id}`)
      .then((r) => r.json())
      .then((p) => {
        if (p?.title) {
          setTitle(p.title);
          setDescription(p.description ?? "");
          setStatus(p.status);
          // Clamp to max priority 3 (High) in case legacy value of 4 exists
          setPriority(String(Math.min(p.priority ?? 2, 3)));
          setStartDate(p.startDate ? p.startDate.split("T")[0] : "");
          setEndDate(p.endDate ? p.endDate.split("T")[0] : "");
          setSuccessTarget(p.successTarget ?? "");
          setIsGoal(p.isGoal ?? false);
          setSubDepartmentId(p.subDepartmentId ?? "");
          // Pre-select existing members
          const existingIds = new Set<string>(
            (p.members ?? []).map((m: { id: string }) => m.id)
          );
          setSelectedMemberIds(existingIds);

          setProjectRequestId(p.projectRequestId ?? null);
          if (p.projectRequestId) {
            setExpectedTotalInitialDays(
              typeof p.expectedTotalInitialDays === "number" ? p.expectedTotalInitialDays : null
            );
            setExpectedStartDate(p.expectedStartDate ? p.expectedStartDate.split("T")[0] : "");
            setExpectedFinishDate(p.expectedFinishDate ? p.expectedFinishDate.split("T")[0] : "");
            setExpenseTypeId(p.expenseTypeId ?? "");
            // Server-derived (withProjectFinancials) — current authoritative
            // totals from this Project's Activities, display-only.
            setEstimatedCost(p.estimatedCost !== null && p.estimatedCost !== undefined ? String(p.estimatedCost) : "0");
            setActualCost(p.actualCost !== null && p.actualCost !== undefined ? String(p.actualCost) : "0");
            setExternal(p.external ?? false);
            fetch("/api/project-expense-types")
              .then((r) => (r.ok ? r.json() : []))
              .then((types: ExpenseTypeOption[]) => {
                // A now-INACTIVE type this Project already references must
                // still appear in the dropdown (and stay selected) — the
                // active-only list alone would silently hide it.
                if (p.expenseType && !types.some((t) => t.id === p.expenseType.id)) {
                  types = [...types, { id: p.expenseType.id, name: p.expenseType.name }];
                }
                setExpenseTypes(types);
              })
              .catch(() => {});
          }

          // Eligible members/sub-departments depend on the project's own
          // department (fixed — this form doesn't let you move departments)
          // — fetched once we know it, not in parallel with the project itself.
          if (p.departmentId) {
            fetch(`/api/users?assignableFor=project&departmentId=${p.departmentId}`)
              .then((r) => (r.ok ? r.json() : []))
              .then((users) => setAssignableUsers(Array.isArray(users) ? users : []));
            fetch(`/api/departments/${p.departmentId}/sub-departments`)
              .then((r) => (r.ok ? r.json() : []))
              .then((options) => setSubDepartments(Array.isArray(options) ? options : []));
          } else {
            fetch("/api/users?assignableFor=project")
              .then((r) => (r.ok ? r.json() : []))
              .then((users) => setAssignableUsers(Array.isArray(users) ? users : []));
          }
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (projectRequestId && expectedStartDate && expectedFinishDate && new Date(expectedFinishDate) < new Date(expectedStartDate)) {
      toast.error("Expected Finish Date cannot be before Expected Start Date.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: description || undefined,
          status,
          priority: parseInt(priority),
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          successTarget: successTarget || undefined,
          memberIds: Array.from(selectedMemberIds),
          isGoal,
          subDepartmentId: subDepartmentId || null,
          // All 7 fields are OPTIONAL here (unlike at request-origin setup
          // time, which stays strictly required — see
          // createProjectFromRequestSchema). This form is always a full
          // snapshot of the currently-displayed state, so an empty field is
          // sent as an explicit `null` ("clear it"), never `undefined`
          // ("leave untouched") and never `Number("")` (`=== 0`, which would
          // silently turn an intentionally-cleared money field into €0.00).
          // See updateProjectRequestOriginFieldsSchema's doc comment for how
          // the PATCH route tells `null` and `undefined` apart.
          ...(projectRequestId
            ? {
                expectedStartDate: expectedStartDate || null,
                expectedFinishDate: expectedFinishDate || null,
                expenseTypeId: expenseTypeId || null,
                // Estimated/Actual Cost are derived server-side and never
                // part of the editable PATCH payload — see
                // updateProjectRequestOriginFieldsSchema in lib/validations.ts.
                external,
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to update project");
      }
      toast.success("Project updated");
      router.push(`/projects/${id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update project");
      setSaving(false);
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
    // No max-width cap (previously max-w-2xl, then max-w-4xl) — a fixed
    // Tailwind cap always clamps at SOME fixed px value regardless of how
    // much room <main> actually has (measured: 720px of unused width at a
    // 1920px viewport, 1360px at 2560px). Fills whatever <main> gives it
    // instead (page padding is <main>'s own p-4 sm:p-6 in
    // app/(main)/layout.tsx, untouched here) — this form's own internal
    // grids distribute that width proportionally on their own.
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        <ChevronRight className="h-4 w-4" />
        <Link href={`/projects/${id}`} className="hover:text-foreground truncate max-w-[200px]">
          {title}
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">Edit</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Edit Project</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                placeholder="Project title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                placeholder="Project description..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>

            {/* Sub-Department (when this department has any configured)
                joins Status/Priority in one responsive row instead of its
                own standalone row — three short single-value selects group
                naturally. Column count adapts to whether Sub-Department is
                actually rendered, so the row never ends with a visually
                empty trailing cell on wide screens. Collapses to a single
                column below `sm` (mobile), 2-up from `sm`, and the full
                adaptive count only from `lg` upward. */}
            <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${subDepartments.length > 0 ? "lg:grid-cols-3" : ""}`}>
              {subDepartments.length > 0 && (
                <div className="space-y-2">
                  <Label>Sub-Department</Label>
                  <Select value={subDepartmentId || "__none__"} onValueChange={(v) => setSubDepartmentId(v === "__none__" ? "" : v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">None</SelectItem>
                      {subDepartments.map((sd) => (
                        <SelectItem key={sd.id} value={sd.id}>
                          {sd.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ProjectStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(ProjectStatus).map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replace(/_/g, " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">High</SelectItem>
                    <SelectItem value="2">Medium</SelectItem>
                    <SelectItem value="1">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {/* Request-origin-only fields — only ever shown for a Project
                created through the request-origin setup flow. A
                manually-created Project never sees (or needs) this block. */}
            {projectRequestId && (
              <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
                <div>
                  <h3 className="text-sm font-semibold">Project Request Setup</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">Metadata from this Project's originating Project Request.</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="expectedStartDate">Expected Start Date</Label>
                    <Input id="expectedStartDate" type="date" value={expectedStartDate} onChange={(e) => setExpectedStartDate(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expectedFinishDate">Expected Finish Date</Label>
                    <Input id="expectedFinishDate" type="date" value={expectedFinishDate} onChange={(e) => setExpectedFinishDate(e.target.value)} />
                  </div>
                </div>

                {/* Expense Type (editable) paired with the readonly baseline
                    day count — both single, short fields, grouped the same
                    way Expected Start/Finish are above. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Expense Type</Label>
                    <Select value={expenseTypeId || "__none__"} onValueChange={(v) => setExpenseTypeId(v === "__none__" ? "" : v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {expenseTypes.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="expectedTotalInitialDays">Expected Total Initial Days</Label>
                    {/* readOnly (never `disabled`) — the creation-time baseline.
                        Editing Expected Start/Finish above never recomputes or
                        overwrites it; there is no code path here or on the
                        server that does. Same visual treatment as the
                        create-flow's own readonly field in project-form.tsx. */}
                    <Input
                      id="expectedTotalInitialDays"
                      type="text"
                      inputMode="none"
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      value={expectedTotalInitialDays !== null ? `${expectedTotalInitialDays} day${expectedTotalInitialDays === 1 ? "" : "s"}` : ""}
                      placeholder="Not set"
                      className="cursor-default bg-muted/40"
                    />
                    <p className="text-xs text-muted-foreground">Baseline set at Project creation — not editable.</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="estimatedCost">Estimated Cost (EUR)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                      <Input
                        id="estimatedCost"
                        type="text"
                        inputMode="none"
                        readOnly
                        aria-readonly="true"
                        tabIndex={-1}
                        className="pl-7 cursor-default bg-muted/40"
                        value={Number(estimatedCost || 0).toFixed(2)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Calculated automatically from this Project's Activities.</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="actualCost">Actual Cost (EUR)</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>
                      <Input
                        id="actualCost"
                        type="text"
                        inputMode="none"
                        readOnly
                        aria-readonly="true"
                        tabIndex={-1}
                        className="pl-7 cursor-default bg-muted/40"
                        value={Number(actualCost || 0).toFixed(2)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">Calculated automatically from completed Activities.</p>
                  </div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="h-4 w-4 rounded" checked={external} onChange={(e) => setExternal(e.target.checked)} />
                  <span className="text-sm font-medium">External</span>
                </label>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="successTarget">Success Target</Label>
              <Textarea
                id="successTarget"
                placeholder="What does success look like?"
                value={successTarget}
                onChange={(e) => setSuccessTarget(e.target.value)}
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded"
                  checked={isGoal}
                  onChange={(e) => setIsGoal(e.target.checked)}
                />
                <span className="text-sm font-medium">This project is a Goal</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Mark this project as a yearly goal for tracking purposes.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Members</Label>
              <p className="text-xs text-muted-foreground">
                Only users eligible for this workspace are listed.
              </p>
              {assignableUsers.length > 0 ? (
                <div className="border rounded-md divide-y max-h-48 overflow-y-auto">
                  {assignableUsers.map((u) => (
                    <label
                      key={u.id}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded"
                        checked={selectedMemberIds.has(u.id)}
                        onChange={() => toggleMember(u.id)}
                      />
                      <span className="text-sm">{u.name ?? u.email}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground border rounded-md px-3 py-2">
                  No eligible users for this workspace yet.
                </p>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
              <Button type="button" variant="outline" onClick={() => router.back()}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
