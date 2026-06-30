import { prisma } from "@/lib/prisma";

// Returns calculated progress (0-100) based on closed/resolved tickets linked to this activity,
// or null if no tickets are linked (caller should keep manual progress value unchanged).
export async function calculateActivityProgress(activityId: string): Promise<number | null> {
  const tickets = await prisma.ticket.findMany({
    where: { activityId },
    include: { status: { select: { isClosed: true, name: true } } },
  });

  if (tickets.length === 0) return null;

  const doneCount = tickets.filter(
    (t) => t.status.isClosed || t.status.name.toLowerCase() === "resolved"
  ).length;

  return Math.round((doneCount / tickets.length) * 100);
}

// Returns calculated progress (0-100) averaged across all activities in the project
// (using ticket-derived progress where available, manual progress otherwise),
// or null if the project has no activities.
export async function calculateProjectProgress(projectId: string): Promise<number | null> {
  const activities = await prisma.projectActivity.findMany({
    where: { projectId },
    select: { id: true, progress: true },
  });

  if (activities.length === 0) return null;

  const progressValues = await Promise.all(
    activities.map(async (act) => {
      const ticketProg = await calculateActivityProgress(act.id);
      return ticketProg !== null ? ticketProg : act.progress;
    })
  );

  return Math.round(progressValues.reduce((a, b) => a + b, 0) / progressValues.length);
}

// For each activity in the project, updates progress if it has linked tickets,
// then updates the project's progress to the average of all activity progress values.
export async function recalculateProjectRollup(projectId: string): Promise<void> {
  const activities = await prisma.projectActivity.findMany({
    where: { projectId },
    select: { id: true, progress: true },
  });

  if (activities.length === 0) return;

  const activityProgresses: number[] = [];

  for (const act of activities) {
    const ticketProg = await calculateActivityProgress(act.id);
    if (ticketProg !== null) {
      await prisma.projectActivity.update({
        where: { id: act.id },
        data: { progress: ticketProg },
      });
      activityProgresses.push(ticketProg);
    } else {
      activityProgresses.push(act.progress);
    }
  }

  const projectProgress = Math.round(
    activityProgresses.reduce((a, b) => a + b, 0) / activityProgresses.length
  );

  await prisma.project.update({
    where: { id: projectId },
    data: { progress: projectProgress },
  });
}

// Recalculates progress for all projects/activities affected by a change to this ticket.
// Handles both project-linked and standalone-activity-linked tickets.
export async function recalculateFromTicket(ticketId: string): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      projectId: true,
      activityId: true,
      activity: { select: { projectId: true } },
    },
  });

  if (!ticket) return;

  const projectIds = new Set<string>();
  if (ticket.projectId) projectIds.add(ticket.projectId);
  if (ticket.activity?.projectId) projectIds.add(ticket.activity.projectId);

  for (const pid of projectIds) {
    await recalculateProjectRollup(pid);
  }

  // Standalone activity (not part of any project): update its progress directly
  if (ticket.activityId && !ticket.activity?.projectId) {
    const ticketProg = await calculateActivityProgress(ticket.activityId);
    if (ticketProg !== null) {
      await prisma.projectActivity.update({
        where: { id: ticket.activityId },
        data: { progress: ticketProg },
      });
    }
  }
}
