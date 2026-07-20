"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, getInitials } from "@/lib/utils";
import { ChevronRight, Loader2, CheckCircle2, Circle, Pencil, Ticket, GitMerge, Trash2, Plus } from "lucide-react";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { formatTicketNumber } from "@/lib/utils";
import { ActivityDeleteButton } from "@/components/activities/activity-delete-button";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";

const STATUS_COLORS: Record<ActivityStatus, string> = {
  TODO: "bg-gray-100 text-gray-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  ON_HOLD: "bg-orange-100 text-orange-700",
  BLOCKED: "bg-red-100 text-red-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-gray-100 text-gray-500",
};

const PRIORITY_COLORS: Record<ActivityPriority, string> = {
  LOW: "bg-green-50 text-green-700",
  MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700",
  URGENT: "bg-red-50 text-red-700",
};

interface Activity {
  id: string;
  title: string;
  description?: string | null;
  status: ActivityStatus;
  priority: ActivityPriority;
  progress: number;
  isCompleted: boolean;
  completedAt?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  createdAt: string;
  project?: { id: string; title: string } | null;
  assignedUsers: { id: string; name?: string | null; email: string; image?: string | null }[];
  department?: { id: string; name: string } | null;
}

interface RelatedTicket {
  id: string;
  ticketNumber: number;
  title: string;
  status: { id: string; name: string; color: string };
}

interface DepActivity {
  id: string;
  title: string;
  status: string;
}

interface Dependency {
  id: string;
  predecessorId: string;
  successorId: string;
  type: string;
  predecessor: DepActivity;
  successor: DepActivity;
}

interface ActivityOption {
  id: string;
  title: string;
}

const DEP_TYPE_LABELS: Record<string, string> = {
  FINISH_TO_START:  "Finish → Start (FS)",
  START_TO_START:   "Start → Start (SS)",
  FINISH_TO_FINISH: "Finish → Finish (FF)",
  START_TO_FINISH:  "Start → Finish (SF)",
};

interface Props {
  id: string;
  isAdmin: boolean;
}

export function ActivityDetailClient({ id, isAdmin }: Props) {
  const router = useRouter();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [relatedTickets, setRelatedTickets] = useState<RelatedTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  // Dependencies
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [allActivities, setAllActivities] = useState<ActivityOption[]>([]);
  const [newPredId, setNewPredId] = useState("");
  const [newDepType, setNewDepType] = useState("FINISH_TO_START");
  const [addingDep, setAddingDep] = useState(false);
  const [removingDepId, setRemovingDepId] = useState<string | null>(null);

  useEffect(() => {
    const fetches: Promise<any>[] = [
      fetch(`/api/activities/${id}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/tickets?activityId=${id}&limit=10`)
        .then((r) => (r.ok ? r.json() : { tickets: [] }))
        .then((d) => d.tickets ?? []),
      fetch(`/api/dependencies?activityId=${id}`).then((r) => (r.ok ? r.json() : [])),
    ];
    if (isAdmin) {
      fetches.push(fetch("/api/activities?limit=200").then((r) => (r.ok ? r.json() : [])));
    }
    Promise.all(fetches)
      .then(([act, tickets, deps, acts]) => {
        setActivity(act);
        setRelatedTickets(tickets);
        setDependencies(Array.isArray(deps) ? deps : []);
        if (acts) {
          const list = (Array.isArray(acts) ? acts : []) as ActivityOption[];
          setAllActivities(list.filter((a: ActivityOption) => a.id !== id));
        }
      })
      .finally(() => setLoading(false));
  }, [id, isAdmin]);

  const addDependency = async () => {
    if (!newPredId) { toast.error("Select a predecessor activity"); return; }
    setAddingDep(true);
    try {
      const res = await fetch("/api/dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ predecessorId: newPredId, successorId: id, type: newDepType }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to add dependency"); return; }
      setDependencies((prev) => [...prev, data]);
      setNewPredId("");
      toast.success("Dependency added");
    } catch {
      toast.error("Failed to add dependency");
    } finally {
      setAddingDep(false);
    }
  };

  const removeDependency = async (depId: string) => {
    setRemovingDepId(depId);
    try {
      const res = await fetch(`/api/dependencies/${depId}`, { method: "DELETE" });
      if (!res.ok) { toast.error("Failed to remove dependency"); return; }
      setDependencies((prev) => prev.filter((d) => d.id !== depId));
      toast.success("Dependency removed");
    } catch {
      toast.error("Failed to remove dependency");
    } finally {
      setRemovingDepId(null);
    }
  };

  const toggleComplete = async () => {
    if (!activity) return;
    setToggling(true);
    try {
      const { isCompleted, status } = await toggleActivityComplete(id, activity.isCompleted);
      setActivity((prev) => (prev ? { ...prev, isCompleted, status: status as ActivityStatus } : prev));
      toast.success(isCompleted ? "Activity completed!" : "Activity reopened");
    } catch (error: any) {
      toast.error(error.message ?? "Failed to update activity");
    } finally {
      setToggling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!activity) {
    return <div>Activity not found</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/activities" className="hover:text-foreground">Activities</Link>
        {activity.project && (
          <>
            <ChevronRight className="h-4 w-4" />
            <Link href={`/projects/${activity.project.id}`} className="hover:text-foreground">
              {activity.project.title}
            </Link>
          </>
        )}
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">{activity.title}</span>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <button onClick={toggleComplete} disabled={toggling} className="mt-1 flex-shrink-0">
                {activity.isCompleted ? (
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground hover:text-primary" />
                )}
              </button>
              <div>
                <CardTitle
                  className={`text-xl ${activity.isCompleted ? "line-through text-muted-foreground" : ""}`}
                >
                  {activity.title}
                </CardTitle>
                <div className="flex items-center gap-2 mt-2">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[activity.status]}`}
                  >
                    {activity.status?.replace(/_/g, " ")}
                  </span>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_COLORS[activity.priority]}`}
                  >
                    {activity.priority}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(`/activities/${id}/edit`)}
              >
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Edit
              </Button>
              <Button
                size="sm"
                variant={activity.isCompleted ? "outline" : "default"}
                onClick={toggleComplete}
                disabled={toggling}
              >
                {toggling && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                {activity.isCompleted ? "Reopen" : "Mark Complete"}
              </Button>
              {isAdmin && (
                <ActivityDeleteButton
                  activityId={id}
                  activityTitle={activity.title}
                  projectId={activity.project?.id ?? null}
                />
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {activity.description && (
            <div>
              <p className="text-sm text-muted-foreground mb-1">Description</p>
              <p className="text-sm whitespace-pre-wrap">{activity.description}</p>
            </div>
          )}
          <Separator />
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-muted-foreground">Progress</p>
              <div className="text-right">
                <span className="text-xs font-medium">{activity.progress}%</span>
                <p className="text-[10px] text-muted-foreground">
                  {relatedTickets.length > 0 ? "Calculated from linked tickets" : "Manual progress"}
                </p>
              </div>
            </div>
            <div className="h-1.5 bg-muted rounded-full">
              <div
                className="h-1.5 bg-primary rounded-full transition-all"
                style={{ width: `${activity.progress}%` }}
              />
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Project</p>
              {activity.project ? (
                <Link
                  href={`/projects/${activity.project.id}`}
                  className="font-medium text-primary hover:underline"
                >
                  {activity.project.title}
                </Link>
              ) : (
                <span className="text-muted-foreground italic">Standalone</span>
              )}
            </div>
            {activity.assignedUsers.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Assigned To</p>
                <div className="flex flex-wrap gap-2">
                  {activity.assignedUsers.map((u) => (
                    <div key={u.id} className="flex items-center gap-1.5">
                      <Avatar className="h-5 w-5">
                        <AvatarImage src={u.image ?? undefined} />
                        <AvatarFallback className="text-[9px]">
                          {getInitials(u.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium text-sm">{u.name ?? u.email}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {activity.startDate && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Start Date</p>
                <p className="font-medium">{formatDate(activity.startDate)}</p>
              </div>
            )}
            {activity.dueDate && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Due Date</p>
                <p className="font-medium">{formatDate(activity.dueDate)}</p>
              </div>
            )}
            {activity.department && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Department</p>
                <p className="font-medium">{activity.department.name}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {/* Dependencies */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            Dependencies ({dependencies.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {dependencies.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-2">
              No dependencies defined.
            </p>
          ) : (
            <div className="space-y-1.5">
              {dependencies.map((dep) => {
                const isPred = dep.predecessorId === id;
                const other  = isPred ? dep.successor : dep.predecessor;
                const label  = DEP_TYPE_LABELS[dep.type] ?? dep.type;
                return (
                  <div key={dep.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${isPred ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"}`}>
                        {isPred ? "blocks" : "blocked by"}
                      </span>
                      <Link href={`/activities/${other.id}`} className="truncate font-medium hover:text-primary transition-colors">
                        {other.title}
                      </Link>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{label}</span>
                    </div>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
                        disabled={removingDepId === dep.id}
                        onClick={() => removeDependency(dep.id)}
                      >
                        {removingDepId === dep.id
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <Trash2 className="h-3 w-3" />
                        }
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {isAdmin && (
            <div className="pt-1 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Add predecessor</p>
              <div className="flex gap-2">
                <Select value={newPredId} onValueChange={setNewPredId}>
                  <SelectTrigger className="h-8 text-xs flex-1 min-w-0">
                    <SelectValue placeholder="Select activity..." />
                  </SelectTrigger>
                  <SelectContent>
                    {allActivities.map((a) => (
                      <SelectItem key={a.id} value={a.id} className="text-xs">
                        {a.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={newDepType} onValueChange={setNewDepType}>
                  <SelectTrigger className="h-8 text-xs w-[130px] shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(DEP_TYPE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" className="h-8 shrink-0" onClick={addDependency} disabled={addingDep || !newPredId}>
                  {addingDep ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Related Tickets */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Ticket className="h-4 w-4" />
            Related Tickets ({relatedTickets.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {relatedTickets.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No tickets linked to this activity.
            </p>
          ) : (
            <div className="space-y-2">
              {relatedTickets.map((t) => (
                <Link
                  key={t.id}
                  href={`/tickets/${t.id}`}
                  className="flex items-center justify-between p-2.5 rounded-lg border hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-muted-foreground shrink-0">
                      {formatTicketNumber(t.ticketNumber)}
                    </span>
                    <span className="text-sm font-medium truncate">{t.title}</span>
                  </div>
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ml-2"
                    style={{
                      backgroundColor: t.status.color + "22",
                      color: t.status.color,
                    }}
                  >
                    {t.status.name}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
