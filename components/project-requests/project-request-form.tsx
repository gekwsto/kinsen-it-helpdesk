"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { createProjectRequestSchema, type CreateProjectRequestInput } from "@/lib/validations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceCombobox } from "@/components/projects/workspace-combobox";
import { Loader2 } from "lucide-react";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";

interface DepartmentOption {
  id: string;
  name: string;
}
interface ProjectTypeOption {
  id: string;
  name: string;
}
interface IntermediateApproverOption {
  id: string;
  name: string | null;
  email: string;
}

interface ProjectRequestFormProps {
  /** The caller's own real, canonical accessible-departments set — the SAME one the workspace selector itself uses (see app/(main)/project-requests/new/page.tsx). A single entry is auto-selected and the picker is hidden entirely. */
  departments: DepartmentOption[];
  /** Every currently-ACTIVE Project Request Type — the page already renders a clean empty state instead of this form when there are none. */
  types: ProjectTypeOption[];
  /** The active workspace's departmentId, ONLY when it's a real department (never the synthetic "All Workspaces" state) and already confirmed by the page to be in `departments` — a pre-selected default when there's more than one option, never an authorization decision; the server re-verifies whatever is actually submitted regardless. */
  defaultDepartmentId?: string;
  /** Every real, currently-eligible intermediate approver, system-wide (never department-scoped) — the page already renders a clean empty state instead of this form when there are none (this stage is mandatory, never silently skipped). */
  intermediateApproverOptions: IntermediateApproverOption[];
}

const IMPORTANCE_LEVELS = [1, 2, 3] as const;

export function ProjectRequestForm({ departments, types, defaultDepartmentId, intermediateApproverOptions }: ProjectRequestFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    clearErrors,
    formState: { errors },
  } = useForm<CreateProjectRequestInput>({
    resolver: zodResolver(createProjectRequestSchema),
    defaultValues: {
      importance: 2,
      replacesExisting: false,
      departmentId: departments.length === 1 ? departments[0].id : defaultDepartmentId,
      intermediateApproverIds: [],
    },
  });

  const importance = watch("importance");
  const projectTypeId = watch("projectTypeId");
  const departmentId = watch("departmentId");
  const replacesExisting = watch("replacesExisting");
  const intermediateApproverIds = watch("intermediateApproverIds") ?? [];

  const toggleIntermediateApprover = (userId: string, checked: boolean) => {
    const current = intermediateApproverIds;
    const next = checked ? [...current, userId] : current.filter((id) => id !== userId);
    setValue("intermediateApproverIds", next, { shouldValidate: true });
  };

  // Client-side filter over the already-loaded, already-eligible
  // `intermediateApproverOptions` — never widens who's offered. Completely
  // separate from `intermediateApproverIds` (the actual react-hook-form
  // selection state): a selected approver who scrolls out of view because
  // of a search stays selected and still submits, since the checkbox's
  // `checked` state below is always read from the UNFILTERED
  // `intermediateApproverIds`, not from this filtered display list.
  const [approverSearch, setApproverSearch] = useState("");
  const approverSearchResults = useMemo(() => {
    const q = approverSearch.trim().toLowerCase();
    if (!q) return intermediateApproverOptions;
    return intermediateApproverOptions.filter((u) => (u.name ?? "").toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [intermediateApproverOptions, approverSearch]);

  const onSubmit = async (data: CreateProjectRequestInput) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/project-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? err.error ?? "Failed to submit Project Request");
      }
      const created = await res.json();
      toast.success("Project Request submitted");
      router.push(`/project-requests/${created.id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Failed to submit Project Request");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
          {departments.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="departmentId">
                Department <span className="text-destructive">*</span>
              </Label>
              <WorkspaceCombobox
                id="departmentId"
                workspaces={departments}
                value={departmentId ?? ""}
                onChange={(v) => setValue("departmentId", v, { shouldValidate: true })}
                placeholder="Select a department"
                // `departments` here is the active-workspace resolver's
                // own take-bounded initial list (WORKSPACE_LIST_TAKE, see
                // lib/services/workspace-service.ts) — a Department beyond
                // that bound wouldn't otherwise be reachable at all. Reuses
                // the EXACT same listAccessibleWorkspaces call (via the
                // pre-existing /api/workspace/search endpoint the header
                // workspace switcher already relies on) that built
                // `departments` in the first place — same eligibility rule,
                // no new endpoint, no authorization change.
                remoteSearch={async (q) => {
                  const res = await fetch(`/api/workspace/search?q=${encodeURIComponent(q)}`);
                  if (!res.ok) return [];
                  const data = await res.json().catch(() => null);
                  return Array.isArray(data?.workspaces) ? data.workspaces : [];
                }}
              />
              {errors.departmentId && <p className="text-xs text-destructive">{errors.departmentId.message}</p>}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input id="title" placeholder="Short, descriptive title" {...register("title")} />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">
              Description <span className="text-destructive">*</span>
            </Label>
            <Textarea id="description" rows={4} placeholder="Describe the proposed project" {...register("description")} />
            {errors.description && <p className="text-xs text-destructive">{errors.description.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="importance">
                Importance level <span className="text-destructive">*</span>
              </Label>
              <Select value={String(importance)} onValueChange={(v) => setValue("importance", Number(v), { shouldValidate: true })}>
                <SelectTrigger id="importance">
                  <SelectValue placeholder="Select importance" />
                </SelectTrigger>
                <SelectContent>
                  {IMPORTANCE_LEVELS.map((level) => (
                    <SelectItem key={level} value={String(level)}>
                      {PROJECT_PRIORITY_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.importance && <p className="text-xs text-destructive">{errors.importance.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="projectTypeId">
                Project Type <span className="text-destructive">*</span>
              </Label>
              <Select value={projectTypeId} onValueChange={(v) => setValue("projectTypeId", v, { shouldValidate: true })}>
                <SelectTrigger id="projectTypeId">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.projectTypeId && <p className="text-xs text-destructive">{errors.projectTypeId.message}</p>}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="teamConcerned">
              Team concerned <span className="text-destructive">*</span>
            </Label>
            <Input id="teamConcerned" placeholder="Which team(s) this affects" {...register("teamConcerned")} />
            {errors.teamConcerned && <p className="text-xs text-destructive">{errors.teamConcerned.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="expectedBenefits">
              Expected benefits <span className="text-destructive">*</span>
            </Label>
            <Textarea id="expectedBenefits" rows={3} placeholder="What benefits will this bring" {...register("expectedBenefits")} />
            {errors.expectedBenefits && <p className="text-xs text-destructive">{errors.expectedBenefits.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="intermediateApproverIds">
              Intermediate Approvers <span className="text-destructive">*</span>
            </Label>
            <p id="intermediateApproverIds-helper" className="text-xs text-muted-foreground">
              Select everyone who must approve this request before it goes to final approval — all of them must approve.
            </p>
            <Input
              placeholder="Search approvers by name or email..."
              value={approverSearch}
              onChange={(e) => setApproverSearch(e.target.value)}
              className="h-8 text-sm"
            />
            <div
              id="intermediateApproverIds"
              role="group"
              aria-describedby={errors.intermediateApproverIds ? "intermediateApproverIds-helper intermediateApproverIds-error" : "intermediateApproverIds-helper"}
              className="max-h-48 overflow-y-auto rounded-md border divide-y"
            >
              {approverSearchResults.map((u) => (
                <label key={u.id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-input"
                    checked={intermediateApproverIds.includes(u.id)}
                    onChange={(e) => toggleIntermediateApprover(u.id, e.target.checked)}
                  />
                  <span>{u.name ?? u.email}</span>
                </label>
              ))}
              {approverSearchResults.length === 0 && (
                <p className="text-xs text-muted-foreground px-3 py-2">No approvers match &quot;{approverSearch}&quot;.</p>
              )}
            </div>
            {errors.intermediateApproverIds && (
              <p id="intermediateApproverIds-error" className="text-xs text-destructive">
                {errors.intermediateApproverIds.message as string}
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={!!replacesExisting}
              onChange={(e) => {
                const checked = e.target.checked;
                setValue("replacesExisting", checked);
                if (!checked) {
                  // Uncheck clears the client-held value entirely — never
                  // sent, never left as hidden stale text if re-checked
                  // later (the textarea below always starts empty again).
                  setValue("replacementDescription", undefined);
                  clearErrors("replacementDescription");
                }
              }}
            />
            Replaces an existing solution/project
          </label>

          {replacesExisting && (
            <div className="space-y-2">
              <Label htmlFor="replacementDescription">
                Solution/project to be replaced <span className="text-destructive">*</span>
              </Label>
              <p id="replacementDescription-helper" className="text-xs text-muted-foreground">
                Describe the existing solution or project that this request will replace.
              </p>
              <Textarea
                id="replacementDescription"
                rows={3}
                maxLength={5000}
                aria-required="true"
                aria-invalid={!!errors.replacementDescription}
                aria-describedby={errors.replacementDescription ? "replacementDescription-helper replacementDescription-error" : "replacementDescription-helper"}
                {...register("replacementDescription")}
              />
              {errors.replacementDescription && (
                <p id="replacementDescription-error" className="text-xs text-destructive">
                  {errors.replacementDescription.message}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit Request
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
