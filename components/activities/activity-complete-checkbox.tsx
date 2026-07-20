"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { toggleActivityComplete } from "@/components/activities/toggle-activity-complete";

interface ActivityCompleteCheckboxProps {
  activityId: string;
  initialIsCompleted: boolean;
  className?: string;
}

/**
 * Small interactive checkbox for use inside an otherwise server-rendered
 * row that's itself wrapped in a <Link> (e.g. the project detail page's
 * activity list) — stops the click from bubbling to the parent Link so
 * toggling doesn't also navigate. Calls router.refresh() on success so the
 * rest of the (server-rendered) row — title strikethrough, status badge —
 * picks up the change too, not just this checkbox's own local state.
 */
export function ActivityCompleteCheckbox({ activityId, initialIsCompleted, className }: ActivityCompleteCheckboxProps) {
  const router = useRouter();
  const [isCompleted, setIsCompleted] = useState(initialIsCompleted);
  const [toggling, setToggling] = useState(false);

  const handleToggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const previous = isCompleted;
    setToggling(true);
    setIsCompleted(!previous);
    try {
      const result = await toggleActivityComplete(activityId, previous);
      setIsCompleted(result.isCompleted);
      router.refresh();
    } catch (error: any) {
      setIsCompleted(previous);
      toast.error(error.message ?? "Failed to update activity");
    } finally {
      setToggling(false);
    }
  };

  if (toggling) {
    return <Loader2 className={`h-4 w-4 flex-shrink-0 animate-spin text-muted-foreground ${className ?? ""}`} />;
  }

  return (
    <input
      type="checkbox"
      checked={isCompleted}
      onChange={() => {}}
      onClick={handleToggle}
      className={`h-4 w-4 rounded flex-shrink-0 cursor-pointer ${className ?? ""}`}
    />
  );
}
