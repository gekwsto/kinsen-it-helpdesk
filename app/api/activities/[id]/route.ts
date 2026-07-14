import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdmin, hasDepartmentPermission } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { updateActivitySchema } from "@/lib/validations";
import { recalculateProjectRollup, calculateActivityProgress } from "@/lib/projects/progress-rollup";
import { Role } from "@prisma/client";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const activity = await prisma.projectActivity.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, title: true } },
        assignedUsers: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
      },
    });

    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canView = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "activity.view");
    if (!canView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json(activity);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const existing = await prisma.projectActivity.findUnique({ where: { id }, select: { departmentId: true } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canEdit = await canActOnEntity(session.user.id, session.user.role, existing.departmentId, "activity.edit");
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const data = updateActivitySchema.parse(body);

    if (data.departmentId !== undefined && data.departmentId !== null && data.departmentId !== existing.departmentId) {
      if (session.user.role !== Role.ADMIN) {
        const targetMembership = await getMembership(session.user.id, data.departmentId);
        const allowed = targetMembership
          ? await hasDepartmentPermission(targetMembership.role, "activity.create")
          : false;
        if (!allowed) {
          return NextResponse.json({ error: "You don't have access to the target department" }, { status: 403 });
        }
      }
    }

    const { dueDate, startDate, isCompleted, assignedUserIds, ...rest } = data;

    if (assignedUserIds && assignedUserIds.length > 0) {
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

    const activity = await prisma.projectActivity.update({
      where: { id },
      data: {
        ...rest,
        startDate: startDate ? new Date(startDate) : startDate === null ? null : undefined,
        dueDate: dueDate ? new Date(dueDate) : dueDate === null ? null : undefined,
        isCompleted: isCompleted ?? undefined,
        completedAt: isCompleted ? new Date() : isCompleted === false ? null : undefined,
        ...(assignedUserIds !== undefined && {
          assignedUsers: { set: assignedUserIds.map((uid) => ({ id: uid })) },
        }),
      },
      include: {
        project: { select: { id: true, title: true } },
        assignedUsers: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    const progressOrStatusChanged = data.progress !== undefined || data.status !== undefined;
    if (progressOrStatusChanged) {
      if (activity.project?.id) {
        recalculateProjectRollup(activity.project.id).catch((err) => {
          console.error("[progress-rollup] activity change recalculation failed:", err);
        });
      } else {
        calculateActivityProgress(id).then((prog) => {
          if (prog !== null) {
            return prisma.projectActivity.update({ where: { id }, data: { progress: prog } });
          }
        }).catch((err) => {
          console.error("[progress-rollup] standalone activity recalculation failed:", err);
        });
      }
    }

    return NextResponse.json(activity);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireAdmin();

    const activity = await prisma.projectActivity.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!activity) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }

    // Safe cascade behaviour (no migration needed):
    //   Ticket.activityId           → nullable, DB SetNull default
    //   _ActivityAssignees join rows → DB CASCADE (implicit M2M)
    await prisma.projectActivity.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
