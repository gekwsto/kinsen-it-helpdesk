"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { createTicketSchema, type CreateTicketInput } from "@/lib/validations";
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
import { Check, Loader2, Paperclip, Plus } from "lucide-react";
import { AttachmentDropzone } from "@/components/tickets/attachment-dropzone";
import { LiveSupportPanel } from "@/components/tickets/live-support-panel";
import { SimpleCommentBox } from "@/components/tickets/simple-comment-box";
import { ProjectCreateDialog } from "@/components/projects/project-create-dialog";
import { ActivityCreateDialog } from "@/components/activities/activity-create-dialog";

interface Agent {
  id: string;
  name: string | null;
  image: string | null;
}

interface TicketFormProject {
  id: string;
  title: string;
}
interface TicketFormActivity {
  id: string;
  title: string;
  projectId: string | null;
}

interface CreateTicketFormProps {
  categories: Array<{ id: string; name: string; departmentId: string | null }>;
  priorities: Array<{ id: string; name: string; color: string; level: number; departmentId: string | null }>;
  departments: Array<{ id: string; name: string }>;
  /** Active workspace's department — pre-selected, and the only choice shown when there's nothing to pick between. */
  defaultDepartmentId?: string | null;
  itAgents: Agent[];
  /** Same hard rule as the Ticket detail page and the generic PATCH route — only System Admin may link a ticket to a Project/Activity (and therefore may inline-create one from here). */
  canLinkProjectActivity: boolean;
  /** Departments (within `departments`) the current user also holds project.create in — bounds which departments show "+ New Project", reusing the same getAccessibleDepartmentSummaries the rest of the app uses for this permission, never a second/parallel check. */
  projectCreateDepartmentIds: string[];
  /** Same, for activity.create. */
  activityCreateDepartmentIds: string[];
}

export function CreateTicketForm({
  categories,
  priorities,
  departments,
  defaultDepartmentId,
  itAgents,
  canLinkProjectActivity,
  projectCreateDepartmentIds,
  activityCreateDepartmentIds,
}: CreateTicketFormProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [pendingComments, setPendingComments] = useState<string[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [projects, setProjects] = useState<TicketFormProject[]>([]);
  const [activities, setActivities] = useState<TicketFormActivity[]>([]);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateTicketInput>({
    resolver: zodResolver(createTicketSchema),
    defaultValues: { departmentId: defaultDepartmentId ?? undefined },
  });

  const selectedDepartmentId = watch("departmentId") ?? defaultDepartmentId ?? undefined;
  const [subDepartments, setSubDepartments] = useState<Array<{ id: string; name: string }>>([]);

  // Sub-departments are scoped to whichever department is currently
  // selected (explicit choice, or the single default) — re-fetched
  // whenever it changes, cleared if none is resolved yet.
  useEffect(() => {
    setValue("subDepartmentId", undefined);
    setValue("shareWithSubDepartment", false);
    if (!selectedDepartmentId) {
      setSubDepartments([]);
      return;
    }
    fetch(`/api/departments/${selectedDepartmentId}/sub-departments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((options) => setSubDepartments(Array.isArray(options) ? options : []))
      .catch(() => setSubDepartments([]));
  }, [selectedDepartmentId, setValue]);

  // Project/Activity options — fetched from the SAME department-scoped,
  // already-authorized endpoints the standalone Projects/Activities list
  // pages use (GET /api/projects?departmentId=, GET /api/activities?departmentId=),
  // never an unbounded "every project in the system" query. Re-fetched
  // whenever the selected department changes (mirrors the sub-department
  // effect above); a previously-selected project/activity that doesn't
  // belong to the NEW department's list is cleared, never silently kept —
  // a ticket must never submit a cross-department Project/Activity link
  // (validateTicketProjectActivityLink is still the final, authoritative
  // check server-side; this only keeps the UI from ever offering or
  // preserving an invalid choice). Only fetched at all when the user can
  // link a ticket to a Project/Activity in the first place — same hard
  // System-Admin-only rule as everywhere else this link is gated.
  //
  // The result is MERGED into (never blindly replaces) local state, and the
  // "clear an invalid selection" step only ever runs when `prevDepartmentIdRef`
  // proves the department genuinely changed between renders. Both guard
  // against the same real race: this fetch can still be in flight when the
  // user inline-creates a Project/Activity (a separate, faster local state
  // update — see handleProjectCreated/handleActivityCreated below). Without
  // these guards, this fetch's OWN department hadn't changed at all — a
  // slow response resolving after that local update would overwrite the
  // freshly-added entry and, worse, treat the just-created (and just
  // selected) id as "not in the list" and wipe the selection.
  const prevDepartmentIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!canLinkProjectActivity || !selectedDepartmentId) {
      prevDepartmentIdRef.current = selectedDepartmentId;
      setProjects([]);
      setActivities([]);
      return;
    }
    const isRealDepartmentChange = prevDepartmentIdRef.current !== undefined && prevDepartmentIdRef.current !== selectedDepartmentId;
    let cancelled = false;
    Promise.all([
      fetch(`/api/projects?departmentId=${selectedDepartmentId}&limit=100`).then((r) => (r.ok ? r.json() : { projects: [] })),
      fetch(`/api/activities?departmentId=${selectedDepartmentId}`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([projectsRes, activitiesRes]) => {
        if (cancelled) return;
        const fetchedProjects: TicketFormProject[] = Array.isArray(projectsRes?.projects)
          ? projectsRes.projects.map((p: any) => ({ id: p.id, title: p.title }))
          : [];
        const fetchedActivities: TicketFormActivity[] = Array.isArray(activitiesRes)
          ? activitiesRes.filter((a: any) => !a.isCompleted).map((a: any) => ({ id: a.id, title: a.title, projectId: a.projectId ?? null }))
          : [];
        setProjects((prev) => [...fetchedProjects, ...prev.filter((p) => !fetchedProjects.some((fp) => fp.id === p.id))]);
        setActivities((prev) => [...fetchedActivities, ...prev.filter((a) => !fetchedActivities.some((fa) => fa.id === a.id))]);

        if (isRealDepartmentChange) {
          const currentProjectId = watch("projectId");
          const currentActivityId = watch("activityId");
          const projectStillValid = !currentProjectId || fetchedProjects.some((p) => p.id === currentProjectId);
          const activityStillValid = !currentActivityId || fetchedActivities.some((a) => a.id === currentActivityId);
          if (!projectStillValid) {
            setValue("projectId", undefined);
            setSelectedProjectId("");
            setValue("activityId", undefined);
          } else if (!activityStillValid) {
            setValue("activityId", undefined);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjects([]);
          setActivities([]);
        }
      });
    prevDepartmentIdRef.current = selectedDepartmentId;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDepartmentId, canLinkProjectActivity]);

  const canCreateProjectHere = canLinkProjectActivity && !!selectedDepartmentId && projectCreateDepartmentIds.includes(selectedDepartmentId);
  const canCreateActivityHere = canLinkProjectActivity && !!selectedDepartmentId && activityCreateDepartmentIds.includes(selectedDepartmentId);

  const selectProject = (projectId: string | null) => {
    setValue("projectId", projectId ?? undefined);
    setSelectedProjectId(projectId ?? "");
  };

  const selectActivity = (activity: TicketFormActivity | null) => {
    setValue("activityId", activity?.id ?? undefined);
    // Keep Project/Activity consistent regardless of HOW the activity was
    // chosen (manual select or inline creation) — an activity that belongs
    // to a project must make that project the ticket's selected project
    // too, so the ticket can never submit projectId=A + activityId=<an
    // activity under B>. validateTicketProjectActivityLink is still the
    // real, final authority server-side; this just keeps the client from
    // ever assembling the invalid combination in the first place.
    if (activity?.projectId && activity.projectId !== watch("projectId")) {
      selectProject(activity.projectId);
    }
  };

  // Selecting a JUST-inline-created Project/Activity can't happen in the
  // SAME commit as adding it to the `projects`/`activities` list: Radix
  // Select's hidden native-<select> autofill sync (SelectBubbleInput) can
  // fire a spurious empty-value change event when the value changes to an
  // id whose <SelectItem>/<option> wasn't registered in the DOM yet at that
  // exact moment — which this app's own onValueChange would otherwise
  // interpret as "the user cleared the selection". Queuing the actual
  // selection as "pending" and applying it only once the corresponding
  // effect below observes the item is REALLY present in `projects`/
  // `activities` guarantees the <SelectItem> exists before the value ever
  // points at it — a real React-lifecycle fix, not a setTimeout guess.
  const [pendingProjectSelection, setPendingProjectSelection] = useState<string | null>(null);
  const [pendingActivitySelection, setPendingActivitySelection] = useState<TicketFormActivity | null>(null);

  useEffect(() => {
    if (pendingProjectSelection && projects.some((p) => p.id === pendingProjectSelection)) {
      selectProject(pendingProjectSelection);
      setPendingProjectSelection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, pendingProjectSelection]);

  useEffect(() => {
    if (pendingActivitySelection && activities.some((a) => a.id === pendingActivitySelection.id)) {
      selectActivity(pendingActivitySelection);
      setPendingActivitySelection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities, pendingActivitySelection]);

  const handleProjectCreated = (project: TicketFormProject) => {
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, project]));
    setPendingProjectSelection(project.id);
  };

  const handleActivityCreated = (activity: { id: string; title: string; projectId: string | null; project: { id: string; title: string } | null }) => {
    setActivities((prev) => (prev.some((a) => a.id === activity.id) ? prev : [...prev, { id: activity.id, title: activity.title, projectId: activity.projectId }]));
    if (activity.project) {
      setProjects((prev) => (prev.some((p) => p.id === activity.project!.id) ? prev : [...prev, activity.project!]));
    }
    setPendingActivitySelection({ id: activity.id, title: activity.title, projectId: activity.projectId });
  };

  // Category/Priority are fetched once (server-side) scoped to the union of
  // every accessible department, then re-filtered here to strictly the
  // currently-selected department (every category/priority is now
  // department-owned, no more global fallback) — mirrors the sub-department
  // reactive-refetch above, just client-side since the full list is already
  // in hand. Clears any previously-selected value that no longer belongs to
  // the newly-selected department, same as subDepartmentId above.
  const visibleCategories = categories.filter((c) => c.departmentId === selectedDepartmentId);
  const visiblePriorities = priorities.filter((p) => p.departmentId === selectedDepartmentId);

  useEffect(() => {
    const currentCategoryId = watch("categoryId");
    if (currentCategoryId && !visibleCategories.some((c) => c.id === currentCategoryId)) {
      setValue("categoryId", undefined);
    }
    const currentPriorityId = watch("priorityId");
    if (currentPriorityId && !visiblePriorities.some((p) => p.id === currentPriorityId)) {
      setValue("priorityId", undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDepartmentId]);

  const uploadAttachment = async (ticketId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    await fetch(`/api/tickets/${ticketId}/attachments`, { method: "POST", body: fd });
  };

  const postInitialMessage = async (ticketId: string, body: string) => {
    await fetch(`/api/tickets/${ticketId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, direction: "INBOUND", isInternal: false }),
    });
  };

  const onSubmit = async (data: CreateTicketInput) => {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to create ticket");
      }

      const ticket = await res.json();

      // Upload attachments (best-effort, non-blocking on error)
      if (files.length > 0) {
        await Promise.allSettled(files.map((f) => uploadAttachment(ticket.id, f)));
      }

      // Post any saved initial messages
      if (pendingComments.length > 0) {
        await Promise.allSettled(
          pendingComments.map((body) => postInitialMessage(ticket.id, body))
        );
      }

      toast.success("Ticket created successfully!");
      router.push(`/tickets/${ticket.id}`);
    } catch (error: any) {
      toast.error(error.message ?? "Something went wrong");
      setIsSubmitting(false);
    }
  };

  const handleInitialComment = async (text: string) => {
    setPendingComments((prev) => [...prev, text]);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="grid gap-6 lg:grid-cols-3">
        {/* ── Left: main content (2/3) ─────────────────────────── */}
        <div className="lg:col-span-2 space-y-5">
          {/* Ticket details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Ticket Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">
                  Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="title"
                  placeholder="Brief summary of your issue…"
                  {...register("title")}
                />
                {errors.title && (
                  <p className="text-xs text-destructive">{errors.title.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">
                  Description <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="description"
                  placeholder="Describe the issue in detail. Include steps to reproduce, error messages, what you expected vs what happened…"
                  className="min-h-[160px] resize-y"
                  {...register("description")}
                />
                {errors.description && (
                  <p className="text-xs text-destructive">{errors.description.message}</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Attachments */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Paperclip className="h-4 w-4" />
                Attachments
                {files.length > 0 && (
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {files.length} file{files.length !== 1 ? "s" : ""} selected
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AttachmentDropzone files={files} onFilesChange={setFiles} />
            </CardContent>
          </Card>

          {/* Initial message */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Initial Message</CardTitle>
              <p className="text-xs text-muted-foreground">
                Optional message to the IT team — sent after your ticket is submitted.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <SimpleCommentBox
                onSubmit={handleInitialComment}
                placeholder="Add context, urgency details, or ask a quick question…"
              />
              {pendingComments.length > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <Check className="h-3 w-3" />
                  {pendingComments.length} message
                  {pendingComments.length > 1 ? "s" : ""} saved — will be posted with ticket
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Right: sidebar (1/3) ─────────────────────────────── */}
        <div className="space-y-4">
          {/* Properties */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Properties</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={watch("categoryId") ?? ""} onValueChange={(v) => setValue("categoryId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select category…" />
                  </SelectTrigger>
                  <SelectContent>
                    {visibleCategories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={watch("priorityId") ?? ""} onValueChange={(v) => setValue("priorityId", v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority…" />
                  </SelectTrigger>
                  <SelectContent>
                    {[...visiblePriorities].sort((a, b) => b.level - a.level).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: p.color }}
                          />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {departments.length > 1 && (
                <div className="space-y-1.5">
                  <Label>Department</Label>
                  <Select
                    defaultValue={defaultDepartmentId ?? undefined}
                    onValueChange={(v) => setValue("departmentId", v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select department…" />
                    </SelectTrigger>
                    <SelectContent>
                      {departments.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {subDepartments.length > 0 && (
                <div className="space-y-1.5">
                  <Label>Sub-Department</Label>
                  <Select
                    value={watch("subDepartmentId") ?? "__none__"}
                    onValueChange={(v) => {
                      setValue("subDepartmentId", v === "__none__" ? undefined : v);
                      if (v === "__none__") setValue("shareWithSubDepartment", false);
                    }}
                  >
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
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={watch("shareWithDepartment") ?? false}
                    onChange={(e) => setValue("shareWithDepartment", e.target.checked)}
                  />
                  <span className="text-sm">Share with my department</span>
                </label>
                <label className={`flex items-center gap-2 ${watch("subDepartmentId") ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded"
                    checked={watch("shareWithSubDepartment") ?? false}
                    disabled={!watch("subDepartmentId")}
                    onChange={(e) => setValue("shareWithSubDepartment", e.target.checked)}
                  />
                  <span className="text-sm">Share with my sub-department</span>
                </label>
                {!watch("subDepartmentId") && (
                  <p className="text-xs text-muted-foreground pl-6">Select a subdepartment before sharing with it.</p>
                )}
              </div>

              {canLinkProjectActivity && (
                <>
                  <div className="space-y-1.5">
                    <Label>Project</Label>
                    <div className="flex gap-1.5">
                      <Select
                        value={watch("projectId") ?? "_none"}
                        onValueChange={(v) => selectProject(v === "_none" ? null : v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="No project" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">No project</SelectItem>
                          {projects.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 gap-1"
                        disabled={!canCreateProjectHere}
                        title={!selectedDepartmentId ? "Select a department first" : !canCreateProjectHere ? "You don't have permission to create a project in this department" : undefined}
                        onClick={() => setProjectDialogOpen(true)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        New
                      </Button>
                    </div>
                    {!selectedDepartmentId && (
                      <p className="text-xs text-muted-foreground">Select a department before creating a project.</p>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label>Activity</Label>
                    <div className="flex gap-1.5">
                      <Select
                        value={watch("activityId") ?? "_none"}
                        onValueChange={(v) => {
                          if (v === "_none") {
                            setValue("activityId", undefined);
                            return;
                          }
                          const activity = activities.find((a) => a.id === v);
                          if (activity) selectActivity(activity);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="No activity" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_none">No activity</SelectItem>
                          {activities
                            .filter(
                              (a) =>
                                !selectedProjectId ||
                                a.projectId === selectedProjectId
                            )
                            .map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.title}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 gap-1"
                        disabled={!canCreateActivityHere}
                        title={!selectedDepartmentId ? "Select a department first" : !canCreateActivityHere ? "You don't have permission to create an activity in this department" : undefined}
                        onClick={() => setActivityDialogOpen(true)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        New
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {selectedDepartmentId && (
            <>
              <ProjectCreateDialog
                open={projectDialogOpen}
                onOpenChange={setProjectDialogOpen}
                departmentId={selectedDepartmentId}
                departmentName={departments.find((d) => d.id === selectedDepartmentId)?.name}
                onCreated={handleProjectCreated}
              />
              <ActivityCreateDialog
                open={activityDialogOpen}
                onOpenChange={setActivityDialogOpen}
                departmentId={selectedDepartmentId}
                preselectedProjectId={selectedProjectId || null}
                onCreated={handleActivityCreated}
              />
            </>
          )}

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Submit Ticket"
            )}
          </Button>

          {/* Live support panel */}
          <LiveSupportPanel agents={itAgents} />
        </div>
      </div>
    </form>
  );
}
