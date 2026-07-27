import { prisma } from "@/lib/prisma";
import { Role, ProjectStatus, ActivityStatus } from "@prisma/client";
import { buildProjectListWhere, buildActivityListWhere } from "@/lib/services/department-scope-service";
import {
  getProjectTerminalConfigsForDepartments,
  getActivityTerminalConfigsForDepartments,
  resolveProjectTerminal,
  resolveActivityTerminal,
} from "@/lib/status-terminal";
import { startOfTodayUtc, isOverdue } from "@/lib/overdue";
import { PROJECT_PRIORITY_LABEL } from "@/lib/project-priority";

const DUE_SOON_DAYS = 7;

const PROJECT_STATUS_COLOR: Record<ProjectStatus, string> = {
  PLANNING: "#3b82f6",
  IN_PROGRESS: "#f59e0b",
  ON_HOLD: "#fb923c",
  COMPLETED: "#10b981",
  CANCELLED: "#d1d5db",
};

const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  PLANNING: "Planning",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const PROJECT_PRIORITY_COLOR: Record<number, string> = {
  1: "#22c55e",
  2: "#eab308",
  3: "#f97316",
};

const OWNER_BAR_COLOR = "#6366f1";

export interface ProjectsDashboardData {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  overdueProjects: number;
  dueSoonProjects: number;
  totalActivities: number;
  completedActivities: number;
  overdueActivities: number;
  byStatus: { name: string; value: number; color: string }[];
  byPriority: { name: string; value: number; color: string }[];
  byOwner: { name: string; count: number; color: string }[];
  recentProjects: {
    id: string;
    title: string;
    status: ProjectStatus;
    progress: number;
    overdue: boolean;
    ownerName: string | null;
    ownerImage: string | null;
  }[];
}

/**
 * Sums a (departmentId, status) grouped count breakdown into a single total,
 * resolving each group's terminal-ness against that group's OWN department
 * (never a single global assumption) — the same small, precise pattern used
 * for every terminal-dependent aggregate below. Result sets here are at most
 * "departments in scope × status values actually used", never one row per
 * project/activity — this is what keeps these queries N+1-free at any scale.
 */
function sumWhereTerminal<S extends string, M>(
  groups: { departmentId: string | null; status: S; _count: { _all: number } }[],
  configMap: M,
  resolve: (configMap: M, departmentId: string | null, status: S) => boolean,
  wantTerminal: boolean
): number {
  let total = 0;
  for (const g of groups) {
    if (resolve(configMap, g.departmentId, g.status) === wantTerminal) total += g._count._all;
  }
  return total;
}

/**
 * All Projects Dashboard metrics (Part 3) in one call — every count is a
 * database aggregate (count/groupBy), never a full-table client-side scan.
 * Scoped identically to /projects and /activities (buildProjectListWhere/
 * buildActivityListWhere) — same department/workspace/permission rules,
 * so this can never show a project or activity the viewer couldn't
 * otherwise see on those pages.
 */
export async function getProjectsDashboardData(
  userId: string,
  role: Role,
  effectiveDepartmentId: string | undefined
): Promise<ProjectsDashboardData | { denied: true }> {
  const [projectScope, activityScope] = await Promise.all([
    buildProjectListWhere(userId, role, effectiveDepartmentId),
    buildActivityListWhere(userId, role, effectiveDepartmentId),
  ]);
  if ("denied" in projectScope || "denied" in activityScope) return { denied: true };

  const projectWhere = projectScope as Record<string, unknown>;
  const activityWhere = activityScope as Record<string, unknown>;

  const now = new Date();
  const todayStartUtc = startOfTodayUtc(now);
  const dueSoonEnd = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);

  const [
    totalProjects,
    projectStatusByDept,
    statusChartGroups,
    priorityChartGroups,
    ownerChartGroups,
    overdueEligibleByDept,
    dueSoonEligibleByDept,
    totalActivities,
    activityStatusByDept,
    overdueActivityEligibleByDept,
    recentProjectsRaw,
  ] = await Promise.all([
    prisma.project.count({ where: projectWhere }),
    prisma.project.groupBy({ by: ["departmentId", "status"], where: projectWhere, _count: { _all: true } }),
    prisma.project.groupBy({ by: ["status"], where: projectWhere, _count: { _all: true } }),
    prisma.project.groupBy({ by: ["priority"], where: projectWhere, _count: { _all: true } }),
    prisma.project.groupBy({
      by: ["ownerId"],
      where: projectWhere,
      _count: { _all: true },
      orderBy: { _count: { ownerId: "desc" } },
      take: 8,
    }),
    prisma.project.groupBy({
      by: ["departmentId", "status"],
      where: { ...projectWhere, endDate: { not: null, lt: todayStartUtc } },
      _count: { _all: true },
    }),
    prisma.project.groupBy({
      by: ["departmentId", "status"],
      where: { ...projectWhere, endDate: { gte: todayStartUtc, lte: dueSoonEnd } },
      _count: { _all: true },
    }),
    prisma.projectActivity.count({ where: activityWhere }),
    prisma.projectActivity.groupBy({ by: ["departmentId", "status"], where: activityWhere, _count: { _all: true } }),
    prisma.projectActivity.groupBy({
      by: ["departmentId", "status"],
      where: { ...activityWhere, dueDate: { not: null, lt: todayStartUtc } },
      _count: { _all: true },
    }),
    prisma.project.findMany({
      where: projectWhere,
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true, title: true, status: true, progress: true, endDate: true, departmentId: true,
        owner: { select: { name: true, image: true } },
      },
    }),
  ]);

  const allProjectDepartmentIds = Array.from(
    new Set([...projectStatusByDept, ...overdueEligibleByDept, ...dueSoonEligibleByDept].map((g) => g.departmentId).filter((id): id is string => !!id))
  );
  const allActivityDepartmentIds = Array.from(
    new Set([...activityStatusByDept, ...overdueActivityEligibleByDept].map((g) => g.departmentId).filter((id): id is string => !!id))
  );

  const [projectTerminalConfigs, activityTerminalConfigs] = await Promise.all([
    getProjectTerminalConfigsForDepartments(allProjectDepartmentIds),
    getActivityTerminalConfigsForDepartments(allActivityDepartmentIds),
  ]);

  const activeProjects = sumWhereTerminal(projectStatusByDept, projectTerminalConfigs, resolveProjectTerminal, false);
  const completedProjects = sumWhereTerminal(projectStatusByDept, projectTerminalConfigs, resolveProjectTerminal, true);
  const overdueProjects = sumWhereTerminal(overdueEligibleByDept, projectTerminalConfigs, resolveProjectTerminal, false);
  const dueSoonProjects = sumWhereTerminal(dueSoonEligibleByDept, projectTerminalConfigs, resolveProjectTerminal, false);

  const completedActivities = sumWhereTerminal(activityStatusByDept, activityTerminalConfigs, resolveActivityTerminal, true);
  const overdueActivities = sumWhereTerminal(overdueActivityEligibleByDept, activityTerminalConfigs, resolveActivityTerminal, false);

  const byStatus = statusChartGroups.map((g) => ({
    name: PROJECT_STATUS_LABEL[g.status],
    value: g._count._all,
    color: PROJECT_STATUS_COLOR[g.status],
  }));

  const byPriority = priorityChartGroups
    .slice()
    .sort((a, b) => b.priority - a.priority)
    .map((g) => ({
      name: PROJECT_PRIORITY_LABEL[g.priority] ?? `Priority ${g.priority}`,
      value: g._count._all,
      color: PROJECT_PRIORITY_COLOR[g.priority] ?? "#94a3b8",
    }));

  const ownerIds = ownerChartGroups.map((g) => g.ownerId);
  const owners = ownerIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, email: true } })
    : [];
  const ownerNameById = new Map(owners.map((o) => [o.id, o.name ?? o.email]));
  const byOwner = ownerChartGroups.map((g) => ({
    name: ownerNameById.get(g.ownerId) ?? "Unknown",
    count: g._count._all,
    color: OWNER_BAR_COLOR,
  }));

  // Per-row overdue for the recent-projects list uses the exact isOverdue
  // rule (not just the SQL prefilter) — each project resolves its own
  // department's terminal config individually, same as /projects itself.
  const recentProjects = recentProjectsRaw.map((p) => {
    const terminal = resolveProjectTerminal(projectTerminalConfigs, p.departmentId, p.status);
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      progress: p.progress,
      overdue: isOverdue(p.endDate, terminal, now),
      ownerName: p.owner.name,
      ownerImage: p.owner.image,
    };
  });

  return {
    totalProjects,
    activeProjects,
    completedProjects,
    overdueProjects,
    dueSoonProjects,
    totalActivities,
    completedActivities,
    overdueActivities,
    byStatus,
    byPriority,
    byOwner,
    recentProjects,
  };
}
