import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { buildProjectDetailWorkbook, type ProjectDetailExportData } from "@/lib/services/project-export-service";

/**
 * "Export to Excel" for a single Project's detail page — reuses
 * hasProjectViewAccess, the EXACT same authorization check
 * app/(main)/projects/[id]/page.tsx itself uses, never a re-derived rule.
 * Three worksheets (Project Details, Financials, Activities); see
 * lib/services/project-export-service.ts for the workbook structure.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      owner: { select: { id: true, name: true } },
      owners: { select: { id: true, name: true } },
      audience: { select: { id: true, name: true } },
      department: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      members: { select: { id: true, name: true } },
      projectRequest: { select: { id: true, title: true } },
      activities: {
        orderBy: { createdAt: "desc" },
        include: {
          assignedUsers: { select: { id: true, name: true } },
          owner: { select: { id: true, name: true } },
          taskType: { select: { id: true, name: true } },
          taskSubType: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const canView = await hasProjectViewAccess(session.user.id, session.user.role, session.user.customRoleId, project);
  if (!canView) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ownerNames = new Set<string>();
  if (project.owner.name) ownerNames.add(project.owner.name);
  for (const o of project.owners) {
    if (o.name) ownerNames.add(o.name);
  }

  const data: ProjectDetailExportData = {
    title: project.title,
    description: project.description,
    status: project.status,
    priority: project.priority,
    origin: project.projectRequestId ? "From Request" : "Manual",
    projectRequestTitle: project.projectRequest?.title ?? null,
    departmentName: project.department?.name ?? null,
    businessUnitName: project.businessUnit?.name ?? null,
    owners: Array.from(ownerNames),
    audience: project.audience.map((a) => a.name).filter((n): n is string => !!n),
    members: project.members.map((m) => m.name).filter((n): n is string => !!n),
    expectedStartDate: project.expectedStartDate,
    expectedFinishDate: project.expectedFinishDate,
    expectedTotalInitialDays: project.expectedTotalInitialDays,
    startDate: project.startDate,
    endDate: project.endDate,
    progress: project.progress,
    createdAt: project.createdAt,
    activities: project.activities.map((a) => ({
      title: a.title,
      status: a.status,
      ownerName: a.owner?.name ?? null,
      relatedUsers: a.assignedUsers.map((u) => u.name).filter((n): n is string => !!n),
      taskTypeName: a.taskType?.name ?? null,
      taskSubTypeName: a.taskSubType?.name ?? null,
      taskSubTypeCost: a.taskSubTypeCost,
      expectedStartDate: a.expectedStartDate,
      expectedFinishDate: a.expectedFinishDate,
      expectedDays: a.expectedDays,
      actualDays: a.actualDays,
      progress: a.progress,
      isCompleted: a.isCompleted,
      createdAt: a.createdAt,
    })),
  };

  const buffer = await buildProjectDetailWorkbook(data);

  const safeTitle = project.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="project-${safeTitle}-export.xlsx"`,
    },
  });
}
