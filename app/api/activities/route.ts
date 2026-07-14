import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import {
  buildActivityListWhere,
  resolveDepartmentForCreate,
  departmentDenialMessage,
  departmentDenialStatus,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { createActivitySchema } from "@/lib/validations";
import { ActivityStatus, Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);

    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");
    const assignedUserId = searchParams.get("assignedUserId");
    const departmentId = searchParams.get("departmentId");

    const scope = await buildActivityListWhere(session.user.id, session.user.role, departmentId);
    if ("denied" in scope) {
      return NextResponse.json({ error: "You don't have access to this department" }, { status: 403 });
    }

    const andConditions: any[] = [scope];
    if (projectId) andConditions.push({ projectId });
    const validStatuses = Object.values(ActivityStatus) as string[];
    if (status && validStatuses.includes(status)) andConditions.push({ status: status as ActivityStatus });
    if (assignedUserId) andConditions.push({ assignedUsers: { some: { id: assignedUserId } } });

    const where: any = { AND: andConditions };

    const activities = await prisma.projectActivity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { id: true, title: true } },
        assignedUsers: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(activities);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const body = await req.json();
    const data = createActivitySchema.parse(body);

    // An activity under a project must live in that project's department —
    // inherit it if the caller didn't specify one, reject a mismatch if
    // they did (same rule as ticket -> project).
    let effectiveRequestedDepartmentId = data.departmentId;
    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
        select: { departmentId: true },
      });
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      if (data.departmentId && project.departmentId && data.departmentId !== project.departmentId) {
        return NextResponse.json(
          { error: "An activity cannot be attached to a project from a different department" },
          { status: 400 }
        );
      }
      effectiveRequestedDepartmentId = data.departmentId ?? project.departmentId ?? undefined;
    }

    // Still nothing explicit — fall back to the caller's active workspace
    // (Phase 2B) before resolveDepartmentForCreate's own fallback.
    if (!effectiveRequestedDepartmentId) {
      const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
      effectiveRequestedDepartmentId = activeWorkspace.departmentId ?? undefined;
    }

    const deptResolution = await resolveDepartmentForCreate(
      session.user.id,
      session.user.role,
      effectiveRequestedDepartmentId,
      "activity.create"
    );
    if ("denied" in deptResolution) {
      return NextResponse.json(
        { error: departmentDenialMessage(deptResolution.denied) },
        { status: departmentDenialStatus(deptResolution.denied) }
      );
    }

    const { dueDate, startDate, assignedUserIds, departmentId: _ignoredDepartmentId, ...rest } = data;

    if (assignedUserIds.length > 0) {
      const adminCount = await prisma.user.count({
        where: { id: { in: assignedUserIds }, role: Role.ADMIN },
      });
      if (adminCount !== assignedUserIds.length) {
        return NextResponse.json(
          { error: "Activities can only be assigned to administrators" },
          { status: 400 }
        );
      }
    }

    const activity = await prisma.projectActivity.create({
      data: {
        ...rest,
        departmentId: deptResolution.departmentId,
        startDate: startDate ? new Date(startDate) : undefined,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        createdById: session.user.id,
        assignedUsers: assignedUserIds.length
          ? { connect: assignedUserIds.map((id) => ({ id })) }
          : undefined,
      },
      include: {
        project: { select: { id: true, title: true } },
        assignedUsers: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    return NextResponse.json(activity, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
