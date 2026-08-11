"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { getInitials } from "@/lib/utils";
import { UserCheck, GitBranch, Tag, Layers, Loader2, FolderKanban, Plus } from "lucide-react";
import { ProjectCreateDialog } from "@/components/projects/project-create-dialog";
import { ActivityCreateDialog } from "@/components/activities/activity-create-dialog";

interface LinkableProject {
  id: string;
  title: string;
}
interface LinkableActivity {
  id: string;
  title: string;
  projectId: string | null;
}

interface TicketActionsProps {
  ticket: {
    id: string;
    statusId: string;
    priorityId?: string | null;
    categoryId?: string | null;
    assignedAgentId?: string | null;
    projectId?: string | null;
    activityId?: string | null;
  };
  statuses: Array<{ id: string; name: string; color: string }>;
  priorities: Array<{ id: string; name: string; color: string; level: number }>;
  categories: Array<{ id: string; name: string }>;
  agents: Array<{
    id: string;
    name?: string | null;
    email: string;
    image?: string | null;
  }>;
  canChangeStatus: boolean;
  canAssign: boolean;
  /** Same hard rule as Create Ticket and the generic PATCH route — only System Admin may link a ticket to a Project/Activity. */
  canLinkProjectActivity: boolean;
  /** The ticket's effective department (legacy-fallback-resolved) — Project/Activity options are fetched scoped to exactly this department, and this is the department a "+ New" inline creation targets. */
  effectiveDepartmentId: string | null;
  canCreateProjectInDept: boolean;
  canCreateActivityInDept: boolean;
}

export function TicketActions({
  ticket,
  statuses,
  priorities,
  categories,
  agents,
  canChangeStatus,
  canAssign,
  canLinkProjectActivity,
  effectiveDepartmentId,
  canCreateProjectInDept,
  canCreateActivityInDept,
}: TicketActionsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  const [statusOpen, setStatusOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);

  const [projects, setProjects] = useState<LinkableProject[]>([]);
  const [activities, setActivities] = useState<LinkableActivity[]>([]);

  // Fetched once, scoped to the ticket's own (fixed — never changes within
  // this dialog) department, from the same GET /api/projects / GET
  // /api/activities the standalone list pages use — never an unbounded
  // "every project/activity in the system" query (the previous behavior,
  // loaded server-side with no department filter at all).
  //
  // Merged into (never overwrites) local state — this fetch can still be in
  // flight when the user inline-creates a Project/Activity via the "+ New"
  // buttons (a separate, faster local state update); a slow response
  // resolving afterward must never wipe out that freshly-added, already-
  // selected entry.
  useEffect(() => {
    if (!canLinkProjectActivity || !effectiveDepartmentId) return;
    let cancelled = false;
    Promise.all([
      fetch(`/api/projects?departmentId=${effectiveDepartmentId}&limit=100`).then((r) => (r.ok ? r.json() : { projects: [] })),
      fetch(`/api/activities?departmentId=${effectiveDepartmentId}`).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([projectsRes, activitiesRes]) => {
        if (cancelled) return;
        const fetchedProjects: LinkableProject[] = Array.isArray(projectsRes?.projects) ? projectsRes.projects.map((p: any) => ({ id: p.id, title: p.title })) : [];
        const fetchedActivities: LinkableActivity[] = Array.isArray(activitiesRes)
          ? activitiesRes.filter((a: any) => !a.isCompleted).map((a: any) => ({ id: a.id, title: a.title, projectId: a.projectId ?? null }))
          : [];
        setProjects((prev) => [...fetchedProjects, ...prev.filter((p) => !fetchedProjects.some((fp) => fp.id === p.id))]);
        setActivities((prev) => [...fetchedActivities, ...prev.filter((a) => !fetchedActivities.some((fa) => fa.id === a.id))]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canLinkProjectActivity, effectiveDepartmentId]);

  const [selectedStatus, setSelectedStatus] = useState(ticket.statusId);
  const [selectedAgent, setSelectedAgent] = useState(ticket.assignedAgentId ?? "");
  const [selectedPriority, setSelectedPriority] = useState(ticket.priorityId ?? "");
  const [selectedCategory, setSelectedCategory] = useState(ticket.categoryId ?? "");
  const [selectedProject, setSelectedProject] = useState(ticket.projectId ?? "");
  const [selectedActivity, setSelectedActivity] = useState(ticket.activityId ?? "");

  // Sync dialog pre-selections when ticket metadata changes from real-time events
  useEffect(() => {
    if (!statusOpen) setSelectedStatus(ticket.statusId);
  }, [ticket.statusId, statusOpen]);

  useEffect(() => {
    if (!assignOpen) setSelectedAgent(ticket.assignedAgentId ?? "");
  }, [ticket.assignedAgentId, assignOpen]);

  useEffect(() => {
    if (!priorityOpen) setSelectedPriority(ticket.priorityId ?? "");
  }, [ticket.priorityId, priorityOpen]);

  useEffect(() => {
    if (!categoryOpen) setSelectedCategory(ticket.categoryId ?? "");
  }, [ticket.categoryId, categoryOpen]);

  // Resets the pending selection back to the ticket's real, saved values
  // whenever the Link dialog is genuinely closed WITHOUT saving (so
  // reopening it later starts fresh, not from a stale abandoned edit) —
  // but NOT when `linkOpen` goes false as part of the create-dialog swap
  // (openProjectCreate/openActivityCreate below also set it false, to show
  // exactly one Radix Dialog at a time). That's an in-progress pause, not a
  // cancel — resetting here would wipe the selection the user is actively
  // building (e.g. a project they just picked, right before creating an
  // Activity under it) out from under them.
  useEffect(() => {
    if (!linkOpen && !projectDialogOpen && !activityDialogOpen) {
      setSelectedProject(ticket.projectId ?? "");
      setSelectedActivity(ticket.activityId ?? "");
    }
  }, [ticket.projectId, ticket.activityId, linkOpen, projectDialogOpen, activityDialogOpen]);

  const patch = async (endpoint: string, data: object, label: string) => {
    setLoading(label);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Request failed");
      toast.success(`${label} updated`);
      // Real-time SSE event will update the UI — no router.refresh() needed
    } catch {
      toast.error(`Failed to update ${label.toLowerCase()}`);
    } finally {
      setLoading(null);
    }
  };

  const handleStatusChange = async () => {
    await patch(
      `/api/tickets/${ticket.id}/status`,
      { statusId: selectedStatus },
      "Status"
    );
    setStatusOpen(false);
  };

  const handleAssign = async () => {
    await patch(
      `/api/tickets/${ticket.id}/assign`,
      { assignedAgentId: selectedAgent || null },
      "Assignment"
    );
    setAssignOpen(false);
  };

  const handlePriorityChange = async () => {
    await patch(
      `/api/tickets/${ticket.id}`,
      { priorityId: selectedPriority || null },
      "Priority"
    );
    setPriorityOpen(false);
  };

  const handleCategoryChange = async () => {
    await patch(
      `/api/tickets/${ticket.id}`,
      { categoryId: selectedCategory || null },
      "Category"
    );
    setCategoryOpen(false);
  };

  // Not routed through the shared patch() helper — Project/Activity aren't
  // real-time-tracked fields (they're plain server props on the detail
  // page, same as Department), so a save needs router.refresh() rather than
  // relying on an SSE event. Also surfaces the backend's actual validation
  // message (e.g. "belongs to a different department") instead of a generic
  // "failed to update" — those specific messages are the whole point of the
  // new validation.
  const handleLinkSave = async () => {
    setLoading("Link");
    try {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProject || null,
          activityId: selectedActivity || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to update project/activity link");
      }
      toast.success("Project/Activity link updated");
      setLinkOpen(false);
      router.refresh();
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update project/activity link");
    } finally {
      setLoading(null);
    }
  };

  const selectActivityWithConsistency = (activity: LinkableActivity) => {
    setSelectedActivity(activity.id);
    // Keep Project/Activity consistent regardless of how the activity was
    // chosen (manual select or inline creation) — never allow saving
    // projectId=A + activityId=<an activity under B>.
    // validateTicketProjectActivityLink is still the real, final authority
    // server-side (see handleLinkSave -> PATCH /api/tickets/[id]); this
    // just keeps the dialog from ever assembling the invalid combination.
    if (activity.projectId && activity.projectId !== selectedProject) {
      setSelectedProject(activity.projectId);
    }
  };

  // Dialog-swap pattern (never two Radix Dialogs open at once): opening a
  // create dialog closes the Link dialog in the SAME state update (React
  // batches these), and the create dialog's own onOpenChange — which fires
  // on Cancel, Escape, an overlay click, AND after a successful onCreated —
  // always restores the Link dialog. This avoids Dialog-inside-Dialog
  // entirely: focus trap/restore, Escape, and body-scroll locking are each
  // handled by exactly one Radix Dialog instance at a time.
  const openProjectCreate = () => {
    setLinkOpen(false);
    setProjectDialogOpen(true);
  };
  const openActivityCreate = () => {
    setLinkOpen(false);
    setActivityDialogOpen(true);
  };
  const closeProjectCreate = (open: boolean) => {
    setProjectDialogOpen(open);
    if (!open) setLinkOpen(true);
  };
  const closeActivityCreate = (open: boolean) => {
    setActivityDialogOpen(open);
    if (!open) setLinkOpen(true);
  };

  // Selecting a JUST-inline-created Project/Activity can't happen in the
  // SAME commit as adding it to the `projects`/`activities` list: Radix
  // Select's hidden native-<select> autofill sync (SelectBubbleInput) can
  // fire a spurious empty-value change event when the value changes to an
  // id whose <SelectItem>/<option> wasn't registered in the DOM yet at that
  // exact moment — this app's own onValueChange would otherwise read that
  // as "the user cleared the selection". Queuing the selection as "pending"
  // and applying it only once the corresponding effect below observes the
  // item is REALLY present guarantees the <SelectItem> exists before the
  // value ever points at it — see components/tickets/ticket-form.tsx's
  // identical fix/comment for the full explanation.
  const [pendingProjectSelection, setPendingProjectSelection] = useState<string | null>(null);
  const [pendingActivitySelection, setPendingActivitySelection] = useState<LinkableActivity | null>(null);

  useEffect(() => {
    if (pendingProjectSelection && projects.some((p) => p.id === pendingProjectSelection)) {
      setSelectedProject(pendingProjectSelection);
      setSelectedActivity("");
      setPendingProjectSelection(null);
    }
  }, [projects, pendingProjectSelection]);

  useEffect(() => {
    if (pendingActivitySelection && activities.some((a) => a.id === pendingActivitySelection.id)) {
      selectActivityWithConsistency(pendingActivitySelection);
      setPendingActivitySelection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities, pendingActivitySelection]);

  const handleProjectCreated = (project: LinkableProject) => {
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, project]));
    setPendingProjectSelection(project.id);
  };

  const handleActivityCreated = (activity: { id: string; title: string; projectId: string | null; project: { id: string; title: string } | null }) => {
    const linkable: LinkableActivity = { id: activity.id, title: activity.title, projectId: activity.projectId };
    setActivities((prev) => (prev.some((a) => a.id === linkable.id) ? prev : [...prev, linkable]));
    if (activity.project) {
      setProjects((prev) => (prev.some((p) => p.id === activity.project!.id) ? prev : [...prev, activity.project!]));
    }
    setPendingActivitySelection(linkable);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Change Status */}
        {canChangeStatus && (
          <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <GitBranch className="h-3.5 w-3.5" />
                Change Status
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Status</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>New Status</Label>
                <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: s.color }}
                          />
                          {s.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleStatusChange} disabled={loading === "Status"}>
                  {loading === "Status" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Update Status
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Assign Agent */}
        {canAssign && (
          <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <UserCheck className="h-3.5 w-3.5" />
                Assign Agent
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Assign Agent</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Assign to</Label>
                <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <span className="text-muted-foreground">Unassigned</span>
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        <span className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={a.image ?? undefined} />
                            <AvatarFallback className="text-[9px]">
                              {getInitials(a.name)}
                            </AvatarFallback>
                          </Avatar>
                          {a.name ?? a.email}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleAssign} disabled={loading === "Assignment"}>
                  {loading === "Assignment" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Assign
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Change Priority */}
        {canChangeStatus && (
          <Dialog open={priorityOpen} onOpenChange={setPriorityOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Layers className="h-3.5 w-3.5" />
                Change Priority
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Priority</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Priority</Label>
                <Select value={selectedPriority} onValueChange={setSelectedPriority}>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <span className="text-muted-foreground">None</span>
                    </SelectItem>
                    {priorities.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: p.color }}
                          />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handlePriorityChange} disabled={loading === "Priority"}>
                  {loading === "Priority" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Update Priority
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Change Category */}
        {canChangeStatus && (
          <Dialog open={categoryOpen} onOpenChange={setCategoryOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <Tag className="h-3.5 w-3.5" />
                Change Category
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change Category</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Category</Label>
                <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      <span className="text-muted-foreground">None</span>
                    </SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button onClick={handleCategoryChange} disabled={loading === "Category"}>
                  {loading === "Category" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Update Category
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {/* Link Project / Activity — same Selects/behavior as Create Ticket's
            Project/Activity fields: choosing a project clears any previously
            selected activity, and the activity list is filtered to that
            project (or shows every activity when no project is selected). */}
        {canLinkProjectActivity && (
          <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                <FolderKanban className="h-3.5 w-3.5" />
                Link Project / Activity
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Link Project / Activity</DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <Label>Project</Label>
                <div className="flex gap-1.5">
                  <Select
                    value={selectedProject || "_none"}
                    onValueChange={(v) => {
                      setSelectedProject(v === "_none" ? "" : v);
                      setSelectedActivity("");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="No project" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No project</SelectItem>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    disabled={!canCreateProjectInDept}
                    title={!canCreateProjectInDept ? "You don't have permission to create a project in this department" : undefined}
                    onClick={openProjectCreate}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </Button>
                </div>

                <Label>Activity</Label>
                <div className="flex gap-1.5">
                  <Select
                    value={selectedActivity || "_none"}
                    onValueChange={(v) => {
                      if (v === "_none") {
                        setSelectedActivity("");
                        return;
                      }
                      const activity = activities.find((a) => a.id === v);
                      if (activity) selectActivityWithConsistency(activity);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="No activity" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No activity</SelectItem>
                      {activities
                        .filter((a) => !selectedProject || a.projectId === selectedProject)
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>{a.title}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1"
                    disabled={!canCreateActivityInDept}
                    title={!canCreateActivityInDept ? "You don't have permission to create an activity in this department" : undefined}
                    onClick={openActivityCreate}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </Button>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleLinkSave} disabled={loading === "Link"}>
                  {loading === "Link" && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>

      {canLinkProjectActivity && effectiveDepartmentId && (
        <>
          <ProjectCreateDialog
            open={projectDialogOpen}
            onOpenChange={closeProjectCreate}
            departmentId={effectiveDepartmentId}
            onCreated={handleProjectCreated}
          />
          <ActivityCreateDialog
            open={activityDialogOpen}
            onOpenChange={closeActivityCreate}
            departmentId={effectiveDepartmentId}
            preselectedProjectId={selectedProject || null}
            onCreated={handleActivityCreated}
          />
        </>
      )}
    </Card>
  );
}
