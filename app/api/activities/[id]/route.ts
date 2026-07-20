import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdmin, hasDepartmentPermission } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
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

    // The completion checkbox always sends isCompleted+status together — a
    // mismatched pair (e.g. isCompleted:true with a non-COMPLETED status, or
    // isCompleted:false with status:COMPLETED) means the two fields drifted
    // apart client-side, which the write must reject rather than silently
    // persist an inconsistent row.
    if (data.isCompleted !== undefined && data.status !== undefined) {
      const consistent = data.isCompleted ? data.status === "COMPLETED" : data.status !== "COMPLETED";
      if (!consistent) {
        return NextResponse.json(
          { error: "isCompleted and status are inconsistent.", code: "invalid_status_transition" },
          { status: 400 }
        );
      }
    }

    if (data.departmentId !== undefined && data.departmentId !== null && data.departmentId !== existing.departmentId) {
      if (session.user.role !== Role.ADMIN) {
        const targetMembership = await getMembership(session.user.id, data.departmentId);
        const allowed = targetMembership
          ? await hasDepartmentPermission(targetMembership.role, "activity.create", targetMembership.customRoleId)
          : false;
        if (!allowed) {
          return NextResponse.json({ error: "You don't have access to the target department" }, { status: 403 });
        }
      }
    }

    const { dueDate, startDate, isCompleted, assignedUserIds, ...rest } = data;
    const effectiveDepartmentId = data.departmentId !== undefined ? data.departmentId : existing.departmentId;

    if (assignedUserIds && assignedUserIds.length > 0) {
      for (const userId of assignedUserIds) {
        const assignable = await userHasAssignablePermissionForEntity(userId, "activity", effectiveDepartmentId);
        if (!assignable) {
          return NextResponse.json(
            { error: "One or more selected users cannot be assigned to activities in this department.", code: "assignee_not_assignable" },
            { status: 400 }
          );
        }
      }
    }

    if (rest.subDepartmentId) {
      const valid = await validateSubDepartmentInDepartment(rest.subDepartmentId, effectiveDepartmentId);
      if (!valid) {
        return NextResponse.json(
          { error: "The selected sub-department does not belong to this activity's department.", code: "subdepartment_department_mismatch" },
          { status: 400 }
        );
      }
    }

    // Department changed but no explicit new sub-department was given — the
    // stale one (if any) can no longer be valid, so it's cleared.
    const departmentChanging = data.departmentId !== undefined && data.departmentId !== existing.departmentId;
    const clearStaleSubDepartment = departmentChanging && rest.subDepartmentId === undefined;

    const activity = await prisma.projectActivity.update({
      where: { id },
      data: {
        ...rest,
        subDepartmentId: clearStaleSubDepartment ? null : rest.subDepartmentId,
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
