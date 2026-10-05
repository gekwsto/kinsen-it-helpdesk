"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getInitials, formatDate } from "@/lib/utils";
import { ActivityCompleteCheckbox, type ActivityToggleResult } from "@/components/activities/activity-complete-checkbox";
import { StatusBadge } from "@/components/shared/activity-status-badge";
import { createTokenGuard } from "@/lib/navigation-loader";
import { GripVertical } from "lucide-react";

export interface SequencedActivityRow {
  id: string;
  title: string;
  dueDate: string | null;
  isCompleted: boolean;
  statusLabel: string;
  statusColor: string;
  owner: { id: string; name: string | null; image: string | null } | null;
  assignedUsers: { id: string; name: string | null; image: string | null }[];
}

interface ProjectActivitySequenceCardProps {
  projectId: string;
  initialActivities: SequencedActivityRow[];
  initialProgress: number;
  progressIsCalculated: boolean;
  /**
   * activity.edit for this Project's own department — the SAME canonical
   * permission every other Activity mutation requires (see
   * lib/services/activity-sequence-service.ts's reorderProjectActivities,
   * the actual authority; this only governs whether the drag handles are
   * even rendered). A user without it still sees the full ordered list,
   * just with no drag affordance at all.
   */
  canReorder: boolean;
}

/**
 * The request-origin Project detail page's own Activities card — an
 * ordered vertical sequence (see ProjectActivity.sequence's own doc
 * comment in prisma/schema.prisma), reorderable via drag-and-drop for a
 * user who holds activity.edit. A manual Project never renders this
 * component at all; it keeps using the plain, unordered
 * ProjectActivitiesCard (app/(main)/projects/[id]/page.tsx is the one
 * place that branches between the two, based on Project.projectRequestId).
 *
 * Ordering only — this component (and the server it talks to) never
 * blocks, requires, or implies anything about completion order; dragging
 * Activity #2 above #1 has no effect on either one's status/dates/cost.
 */
export function ProjectActivitySequenceCard({ projectId, initialActivities, initialProgress, progressIsCalculated, canReorder }: ProjectActivitySequenceCardProps) {
  const [activities, setActivities] = useState(initialActivities);
  const [progress, setProgress] = useState(initialProgress);
  const [saving, setSaving] = useState(false);

  // Same stale-response guard ProjectActivitiesCard already uses for the
  // shared project-level progress aggregate.
  const tokenGuardRef = useRef(createTokenGuard());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const totalActivities = activities.length;
  const completedActivities = activities.filter((a) => a.isCompleted).length;

  const handleToggled = (activityId: string) => (result: ActivityToggleResult) => {
    const myToken = tokenGuardRef.current.bump();
    setActivities((prev) => prev.map((a) => (a.id === activityId ? { ...a, isCompleted: result.isCompleted, statusLabel: result.statusLabel, statusColor: result.statusColor } : a)));
    const rollup = result.projectRollups.find((r) => r.id === projectId);
    if (rollup && tokenGuardRef.current.isCurrent(myToken)) {
      setProgress(rollup.progress);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = activities.findIndex((a) => a.id === active.id);
    const newIndex = activities.findIndex((a) => a.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Numbering updates IMMEDIATELY, optimistically — reverted below only
    // if the server rejects it (e.g. a race with someone else's concurrent
    // edit, or a permission that was revoked mid-session).
    const previousOrder = activities;
    const reordered = arrayMove(activities, oldIndex, newIndex);
    setActivities(reordered);
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/activities/order`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityIds: reordered.map((a) => a.id) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to save the new order");
      }
    } catch (error: any) {
      setActivities(previousOrder);
      toast.error(error.message ?? "Failed to save the new order");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Activities ({totalActivities})</CardTitle>
        {totalActivities > 0 && (
          <div className="text-right">
            <span className="text-sm text-muted-foreground">{progress}%</span>
            <p className="text-[10px] text-muted-foreground">
              {completedActivities} of {totalActivities} complete
              {progressIsCalculated ? " · Calculated from linked tickets" : " · Manual progress"}
            </p>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {totalActivities > 0 && (
          <div className="h-2 bg-muted rounded-full mb-4">
            <div className="h-2 bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}

        {activities.length === 0 ? (
          <p className="text-center text-muted-foreground py-8 text-sm">No activities yet.</p>
        ) : canReorder ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={activities.map((a) => a.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2" aria-disabled={saving}>
                {activities.map((activity, index) => (
                  <SequencedActivityRowItem
                    key={activity.id}
                    activity={activity}
                    position={index + 1}
                    draggable
                    onToggled={handleToggled(activity.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        ) : (
          <div className="space-y-2">
            {activities.map((activity, index) => (
              <SequencedActivityRowItem
                key={activity.id}
                activity={activity}
                position={index + 1}
                draggable={false}
                onToggled={handleToggled(activity.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SequencedActivityRowItem({
  activity,
  position,
  draggable,
  onToggled,
}: {
  activity: SequencedActivityRow;
  position: number;
  draggable: boolean;
  onToggled: (result: ActivityToggleResult) => void;
}) {
  // useSortable is always called (hooks can't be conditional) — its
  // listeners/attributes are simply never spread onto anything when
  // `draggable` is false, and `disabled: !draggable` keeps dnd-kit itself
  // from reacting to this item at all in that case.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: activity.id, disabled: !draggable });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 rounded-lg border bg-card transition-colors ${isDragging ? "opacity-60 shadow-lg" : "hover:bg-muted/50"}`}
    >
      {draggable && (
        // The ONLY drag-sensitive element — grabbing it never navigates;
        // the rest of the row stays a normal clickable Link. Keyboard
        // users: Tab to focus, Space to pick up, Arrow Up/Down to move,
        // Space to drop (dnd-kit's own built-in KeyboardSensor behavior).
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="flex-shrink-0 self-stretch px-2 flex items-center justify-center text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
          aria-label={`Reorder "${activity.title}" (currently position ${position})`}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <Link
        href={`/activities/${activity.id}`}
        className="flex-1 min-w-0 flex items-center justify-between gap-3 p-3 pl-0"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex-shrink-0 w-5 text-sm font-semibold text-muted-foreground text-right tabular-nums">{position}.</span>
          <ActivityCompleteCheckbox activityId={activity.id} initialIsCompleted={activity.isCompleted} onToggled={onToggled} />
          <div className="min-w-0">
            <p className={`text-sm font-medium truncate ${activity.isCompleted ? "line-through text-muted-foreground" : ""}`}>
              {activity.title}
            </p>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <StatusBadge label={activity.statusLabel} color={activity.statusColor} />
              {activity.owner && <span className="text-xs text-muted-foreground truncate">Owner: {activity.owner.name ?? "—"}</span>}
              {activity.dueDate && <span className="text-xs text-muted-foreground whitespace-nowrap">Due: {formatDate(activity.dueDate)}</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {activity.assignedUsers.slice(0, 2).map((u) => (
            <Avatar key={u.id} className="h-6 w-6 ring-2 ring-background -ml-1 first:ml-0">
              <AvatarImage src={u.image ?? undefined} />
              <AvatarFallback className="text-[10px]">{getInitials(u.name)}</AvatarFallback>
            </Avatar>
          ))}
        </div>
      </Link>
    </div>
  );
}
