"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { createProjectSchema, type CreateProjectInput } from "@/lib/validations";
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
import { Loader2, ChevronLeft, ShieldOff } from "lucide-react";
import Link from "next/link";
import { ProjectStatus } from "@prisma/client";

interface AssignableUser {
  id: string;
  name: string | null;
  email: string;
}

interface DepartmentOption {
  id: string;
  name: string;
}

interface SubDepartmentOption {
  id: string;
  name: string;
}

export interface CreatedProject {
  id: string;
  title: string;
  departmentId: string | null;
}

interface ProjectFormProps {
  departments: DepartmentOption[];
  /** Preselected department — the active workspace's department if it's in `departments`, or the sole option if there's exactly one. Undefined forces an explicit choice. */
  defaultDepartmentId?: string;
  /**
   * "standalone" (default) — the full /projects/new page experience:
   * department is a real choice, success redirects to /projects/{id}.
   * "inline" — embedded in a modal (e.g. from the Ticket create/link flow):
   * department is FIXED to `fixedDepartmentId` (never a Select — this is
   * the actual enforcement point that a ticket can never end up linked to a
   * project from another department; POST /api/projects itself is still
   * the authoritative validator, this just never offers the invalid choice
   * in the first place), and success calls `onCreated` instead of
   * navigating away.
   */
  mode?: "standalone" | "inline";
  /** Required when mode="inline" — the department this project MUST belong to. */
  fixedDepartmentId?: string;
  fixedDepartmentName?: string;
  onCreated?: (project: CreatedProject) => void;
  onCancel?: () => void;
}

export function ProjectForm({ departments, defaultDepartmentId, mode = "standalone", fixedDepartmentId, fixedDepartmentName, onCreated, onCancel }: ProjectFormProps) {
  const router = useRouter();
  const inline = mode === "inline";
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      status: ProjectStatus.PLANNING,
      priority: 2,
      memberIds: [],
      isGoal: false,
      departmentId: inline ? fixedDepartmentId : defaultDepartmentId,
    },
  });

  const departmentId = inline ? fixedDepartmentId : watch("departmentId");
  const [subDepartments, setSubDepartments] = useState<SubDepartmentOption[]>([]);

  // Eligible members depend on the selected workspace — re-fetched whenever
  // it changes, not loaded once and filtered in the browser.
  useEffect(() => {
    const url = `/api/users?assignableFor=project${departmentId ? `&departmentId=${departmentId}` : ""}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : []))
      .then((users) => setAssignableUsers(Array.isArray(users) ? users : []))
      .catch(() => {});
  }, [departmentId]);

  // Sub-departments are scoped to the selected workspace — cleared and
  // re-fetched whenever the workspace changes, since a sub-department from
  // the previous department is never valid for the new one.
  useEffect(() => {
    setValue("subDepartmentId", undefined);
    if (!departmentId) {
      setSubDepartments([]);
      return;
    }
    fetch(`/api/departments/${departmentId}/sub-departments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setSubDepartments(Array.isArray(options) ? options : []))
      .catch(() => setSubDepartments([]));
  }, [departmentId, setValue]);

  const toggleMember = (userId: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      setValue("memberIds", Array.from(next));
      return next;
    });
  };

  const onSubmit = async (data: CreateProjectInput) => {
    // In inline mode the department is never user-editable, so this can
    // only trip if the caller forgot to pass fixedDepartmentId — a real
    // programming error, not a user-facing validation case.
    const effectiveDepartmentId = inline ? fixedDepartmentId : data.departmentId;
    if (!effectiveDepartmentId) {
      toast.error("Choose a workspace for this project.");
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // POST /api/projects is the authoritative scope validator (resolveDepartmentForCreate)
        // regardless of what's sent here — this only ever narrows what the
        // UI OFFERS, never widens what the backend accepts.
        body: JSON.stringify({ ...data, departmentId: effectiveDepartmentId, memberIds: Array.from(selectedMemberIds) }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to create project");
      }
      const project = await res.json();
      toast.success("Project created!");
      if (inline) {
        onCreated?.({ id: project.id, title: project.title, departmentId: project.departmentId ?? null });
      } else {
        router.push(`/projects/${project.id}`);
      }
    } catch (error: any) {
      toast.error(error.message ?? "Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!inline && departments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[40vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">No workspace to create in</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have permission to create a project in any workspace. Contact your administrator to request access.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Card className={inline ? "border-none shadow-none" : undefined}>
        {!inline && (
          <CardHeader>
            <CardTitle className="text-base">Project Details</CardTitle>
          </CardHeader>
        )}
        <CardContent className={inline ? "space-y-4 px-0" : "space-y-4"}>
          <div className="space-y-2">
            <Label htmlFor="title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input id="title" {...register("title")} placeholder="Project title..." />
            {errors.title && (
              <p className="text-xs text-destructive">{errors.title.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              {...register("description")}
              placeholder="Project description..."
              className="min-h-[100px]"
            />
          </div>

          {inline ? (
            // Fixed, never a Select — this IS the enforcement point that an
            // inline-created project can never end up in a different
            // department than the ticket it's being created from.
            <div className="space-y-2">
              <Label>Workspace</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
                {fixedDepartmentName ?? "This ticket's department"}
              </div>
            </div>
          ) : (
          <div className="space-y-2">
            <Label>
              Workspace <span className="text-destructive">*</span>
            </Label>
            <Select
              value={departmentId ?? ""}
              onValueChange={(v) => setValue("departmentId", v, { shouldValidate: true })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose a workspace…" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              This project will belong to the selected workspace.
            </p>
          </div>
          )}

          {subDepartments.length > 0 && (
            <div className="space-y-2">
              <Label>Sub-Department</Label>
              <Select
                value={watch("subDepartmentId") ?? ""}
                onValueChange={(v) => setValue("subDepartmentId", v || undefined)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {subDepartments.map((sd) => (
                    <SelectItem key={sd.id} value={sd.id}>
                      {sd.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Optional — narrows this project within the workspace.</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                defaultValue={ProjectStatus.PLANNING}
                onValueChange={(v) => setValue("status", v as ProjectStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(ProjectStatus).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Priority</Label>
              <Select
                defaultValue="2"
                onValueChange={(v) => setValue("priority", parseInt(v))}
              >
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

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Start Date</Label>
              <Input type="date" {...register("startDate")} />
            </div>
            <div className="space-y-2">
              <Label>End Date</Label>
              <Input type="date" {...register("endDate")} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Success Target</Label>
            <Textarea
              {...register("successTarget")}
              placeholder="What does success look like?"
              className="min-h-[80px]"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded"
                {...register("isGoal")}
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

          <div className="flex justify-end gap-3 pt-2">
            {inline ? (
              <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
                Cancel
              </Button>
            ) : (
              <Button type="button" variant="outline" asChild>
                <Link href="/projects">Cancel</Link>
              </Button>
            )}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Project
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
