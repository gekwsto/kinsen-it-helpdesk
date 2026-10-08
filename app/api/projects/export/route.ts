import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { buildProjectListQuery, type ProjectListFilterParams } from "@/lib/services/project-query-service";
import { getProjectTerminalConfigsForDepartments, resolveProjectTerminal } from "@/lib/status-terminal";
import { isProjectOverdue } from "@/lib/overdue";
import { buildProjectsListWorkbook, type ProjectExportRow } from "@/lib/services/project-export-service";

/**
 * "Export to Excel" for the All Projects list — intentionally re-reads the
 * SAME `?search=/?status=/?sortBy=/...` query params the list page
 * (app/(main)/projects/page.tsx) reads, resolves the SAME effectiveDepartmentId
 * (active workspace or an explicit `?departmentId=`, validated the exact
 * same way), and calls the SAME buildProjectListQuery — so this can never
 * show a different set of Projects than what the triggering page's current
 * filters show on screen. No `skip`/`take`: every authorized, matching row
 * is exported, never just the current page.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const navFlags = await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId);
  if (!navFlags.canViewProjects) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const params: ProjectListFilterParams & { departmentId?: string } = {
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortOrder: searchParams.get("sortOrder") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    status: searchParams.get("status") ?? undefined,
    statusGroup: searchParams.get("statusGroup") ?? undefined,
    overdue: searchParams.get("overdue") ?? undefined,
    priority: searchParams.get("priority") ?? undefined,
    origin: searchParams.get("origin") ?? undefined,
    ownerId: searchParams.get("ownerId") ?? undefined,
    memberId: searchParams.get("memberId") ?? undefined,
    subDepartmentId: searchParams.get("subDepartmentId") ?? undefined,
    startDateAfter: searchParams.get("startDateAfter") ?? undefined,
    startDateBefore: searchParams.get("startDateBefore") ?? undefined,
    dueDateAfter: searchParams.get("dueDateAfter") ?? undefined,
    dueDateBefore: searchParams.get("dueDateBefore") ?? undefined,
    createdAfter: searchParams.get("createdAfter") ?? undefined,
    createdBefore: searchParams.get("createdBefore") ?? undefined,
    hasActivities: searchParams.get("hasActivities") ?? undefined,
    activityStatus: searchParams.get("activityStatus") ?? undefined,
    activityOverdue: searchParams.get("activityOverdue") ?? undefined,
    departmentId: searchParams.get("departmentId") ?? undefined,
  };

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId && !activeWorkspace.isAllSelected) {
    return NextResponse.json({ error: "No accessible workspace" }, { status: 403 });
  }
  const effectiveDepartmentId = params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  const query = await buildProjectListQuery(session.user.id, session.user.role, effectiveDepartmentId, params);
  if (query.denied) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  const { where, orderBy } = query;

  const projects = await prisma.project.findMany({
    where,
    orderBy,
    include: {
      owner: { select: { id: true, name: true } },
      owners: { select: { id: true, name: true } },
      department: { select: { id: true, name: true } },
      members: { select: { id: true, name: true } },
      _count: { select: { activities: true } },
    },
  });

  const terminalConfigs = await getProjectTerminalConfigsForDepartments(
    projects.map((p) => p.departmentId).filter((id): id is string => !!id)
  );
  const now = new Date();

  const rows: ProjectExportRow[] = projects.map((p) => {
    const ownerNames = new Set<string>();
    if (p.owner.name) ownerNames.add(p.owner.name);
    for (const o of p.owners) {
      if (o.name) ownerNames.add(o.name);
    }
    return {
      title: p.title,
      description: p.description,
      status: p.status,
      priority: p.priority,
      origin: p.projectRequestId ? "From Request" : "Manual",
      departmentName: p.department?.name ?? null,
      owners: Array.from(ownerNames),
      members: p.members.map((m) => m.name).filter((n): n is string => !!n),
      activitiesCount: p._count.activities,
      progress: p.progress,
      overdue: isProjectOverdue(p.endDate, resolveProjectTerminal(terminalConfigs, p.departmentId, p.status), now),
      expectedStartDate: p.expectedStartDate,
      expectedFinishDate: p.expectedFinishDate,
      startDate: p.startDate,
      endDate: p.endDate,
      createdAt: p.createdAt,
    };
  });

  const buffer = await buildProjectsListWorkbook(rows);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="projects-export-${now.toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
