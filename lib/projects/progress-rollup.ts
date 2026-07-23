import { prisma } from "@/lib/prisma";

// Activity progress is now derived from status (see
// lib/activities/activity-progress.ts), kept in sync on every write in
// app/api/activities/[id]/route.ts and app/api/activities/route.ts — it no
// longer depends on ticket completion state at all, so there is nothing left
// to recalculate in response to a ticket's own status/project/activity
// changes (the ticket-completion-ratio mechanism that used to live here,
// calculateActivityProgress/calculateProjectProgress/recalculateFromTicket,
// has been retired).

/** Recomputes Project.progress as the average of its activities' (always status-derived, always in-sync) progress values. Called when an activity's status changes or it moves between projects. */
export async function recalculateProjectRollup(projectId: string): Promise<void> {
  const activities = await prisma.projectActivity.findMany({
    where: { projectId },
    select: { progress: true },
  });

  if (activities.length === 0) return;

  const projectProgress = Math.round(
    activities.reduce((sum, a) => sum + a.progress, 0) / activities.length
  );

  await prisma.project.update({
    where: { id: projectId },
    data: { progress: projectProgress },
  });
}
