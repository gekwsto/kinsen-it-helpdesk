"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDate, getInitials } from "@/lib/utils";
import { ChevronRight, Loader2, CheckCircle2, Circle, Pencil, Ticket } from "lucide-react";
import { ActivityStatus, ActivityPriority } from "@prisma/client";
import { formatTicketNumber } from "@/lib/utils";

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
  assignedUser?: { id: string; name?: string | null; email: string; image?: string | null } | null;
  department?: { id: string; name: string } | null;
}

interface RelatedTicket {
  id: string;
  ticketNumber: number;
  title: string;
  status: { id: string; name: string; color: string };
}

export default function ActivityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [activity, setActivity] = useState<Activity | null>(null);
  const [relatedTickets, setRelatedTickets] = useState<RelatedTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/activities/${id}`).then((r) => r.json()),
      fetch(`/api/tickets?activityId=${id}&limit=10`)
        .then((r) => (r.ok ? r.json() : { tickets: [] }))
        .then((d) => d.tickets ?? []),
    ])
      .then(([act, tickets]) => {
        setActivity(act);
        setRelatedTickets(tickets);
      })
      .finally(() => setLoading(false));
  }, [id]);

  const toggleComplete = async () => {
    if (!activity) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/activities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isCompleted: !activity.isCompleted,
          status: !activity.isCompleted ? "COMPLETED" : "IN_PROGRESS",
        }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setActivity(updated);
      toast.success(updated.isCompleted ? "Activity completed!" : "Activity reopened");
    } catch {
      toast.error("Failed to update activity");
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
                    {activity.status.replace(/_/g, " ")}
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
            {activity.assignedUser && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Assigned To</p>
                <div className="flex items-center gap-2">
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={activity.assignedUser.image ?? undefined} />
                    <AvatarFallback className="text-[9px]">
                      {getInitials(activity.assignedUser.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{activity.assignedUser.name}</span>
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
