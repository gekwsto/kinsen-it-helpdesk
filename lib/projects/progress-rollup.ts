import { prisma } from "@/lib/prisma";
import { getProgressConfigsForDepartments, resolveProgress } from "@/lib/activities/activity-progress";

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
 */
export async function recalculateProjectRollup(projectId: string): Promise<void> {
  const activities = await prisma.projectActivity.findMany({
    where: { projectId },
    select: { departmentId: true, status: true },
  });

  if (activities.length === 0) return;

  const departmentIds = activities.map((a) => a.departmentId).filter((id): id is string => !!id);
  const progressConfigs = await getProgressConfigsForDepartments(departmentIds);

  const resolved = activities
    .map((a) => resolveProgress(progressConfigs, a.departmentId, a.status))
    .filter((r): r is { ok: true; percent: number } => r.ok);

  if (resolved.length === 0) {
    console.error(`[progress-rollup] projectId=${projectId}: every activity has a progress configuration gap — leaving Project.progress unchanged rather than fabricating an average.`);
    return;
  }
  if (resolved.length < activities.length) {
    console.error(`[progress-rollup] projectId=${projectId}: ${activities.length - resolved.length} of ${activities.length} activities have a progress configuration gap and were excluded from this average (not counted as 0%).`);
  }

  const projectProgress = Math.round(resolved.reduce((sum, r) => sum + r.percent, 0) / resolved.length);

  await prisma.project.update({
    where: { id: projectId },
    data: { progress: projectProgress },
  });
}
