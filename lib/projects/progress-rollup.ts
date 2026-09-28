import { prisma } from "@/lib/prisma";
import { getProgressConfigsForDepartments, resolveProgress } from "@/lib/activities/activity-progress";

/**
 * Authoritative rollup snapshot returned to every caller that needs to hand
 * the RESULT (not just the fact that it ran) straight back to a client —
 * e.g. PATCH /api/activities/[id] returning it so the Project detail page
 * can update its progress bar/counters immediately from the response
 * instead of re-fetching the whole page. `progress` always reflects
 * whatever is now actually committed in Project.progress (including the
 * "left unchanged" case below), never a value computed but not persisted.
 */
export interface ProjectRollupResult {
  id: string;
  progress: number;
  completedActivities: number;
  totalActivities: number;
}

/**
 * Recomputes Project.progress as the average of its activities' progress —
 * resolved LIVE against each activity's department's CURRENT
 * ActivityProgressConfig (not the possibly-stale stored `.progress` column),
 * so Project/Dashboard progress can never drift out of sync with what the
 * Activities/Gantt pages show for the same activities (both resolve the
 * same way, via lib/activities/activity-progress.ts's single resolver).
 *
 * An activity whose status has no usable config (a real configuration gap —
 * see lib/activities/activity-progress.ts's no-fallback policy) is EXCLUDED
 * from both the sum and the count, never counted as 0%: a gap is not a
 * business value, so it must not silently pull the average down. If every
 * activity in the project is gapped, Project.progress is left unchanged
 * (there is nothing real to average) rather than being overwritten with a
 * fabricated number — this should not happen in normal operation, since
 * /api/admin/activity-progress's usage-analysis guard blocks disabling or
 * deleting a config row any existing activity currently depends on.
 *
 * Single query for the activity set (department+status+isCompleted only —
 * completedActivities/totalActivities are derived from this same result,
 * never a second count query), one batched config fetch across every
 * distinct department involved (never one query per activity), and at most
 * one project update — this was already the shape before returning a
 * result; returning one adds no additional query on the normal path.
 */
export async function recalculateProjectRollup(projectId: string): Promise<ProjectRollupResult | null> {
  const activities = await prisma.projectActivity.findMany({
    where: { projectId },
    select: { departmentId: true, status: true, isCompleted: true },
  });

  if (activities.length === 0) return null;

  const totalActivities = activities.length;
  const completedActivities = activities.filter((a) => a.isCompleted).length;

  const departmentIds = activities.map((a) => a.departmentId).filter((id): id is string => !!id);
  const progressConfigs = await getProgressConfigsForDepartments(departmentIds);

  const resolved = activities
    .map((a) => resolveProgress(progressConfigs, a.departmentId, a.status))
    .filter((r): r is { ok: true; percent: number } => r.ok);

  if (resolved.length === 0) {
    console.error(`[progress-rollup] projectId=${projectId}: every activity has a progress configuration gap — leaving Project.progress unchanged rather than fabricating an average.`);
    const current = await prisma.project.findUnique({ where: { id: projectId }, select: { progress: true } });
    return { id: projectId, progress: current?.progress ?? 0, completedActivities, totalActivities };
  }
  if (resolved.length < activities.length) {
    console.error(`[progress-rollup] projectId=${projectId}: ${activities.length - resolved.length} of ${activities.length} activities have a progress configuration gap and were excluded from this average (not counted as 0%).`);
  }

  const projectProgress = Math.round(resolved.reduce((sum, r) => sum + r.percent, 0) / resolved.length);

  await prisma.project.update({
    where: { id: projectId },
    data: { progress: projectProgress },
  });

  return { id: projectId, progress: projectProgress, completedActivities, totalActivities };
}
