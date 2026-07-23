import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdmin, hasDepartmentPermission } from "@/lib/permissions";
import { canActOnEntity } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { updateActivitySchema } from "@/lib/validations";
import { recalculateProjectRollup } from "@/lib/projects/progress-rollup";
import { getActivityProgressFromStatus } from "@/lib/activities/activity-progress";
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

    // Recomputed fresh against the department's CURRENT config, not just the
    // last-written stored value — so an admin's later percentage edit shows
    // up immediately without needing the activity's status to change again.
    const progress = await getActivityProgressFromStatus(activity.departmentId, activity.status);

    return NextResponse.json({ ...activity, progress });
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

    const existing = await prisma.projectActivity.findUnique({
      where: { id },
      select: { departmentId: true, startDate: true, dueDate: true, status: true, projectId: true },
    });
    if (!existing) return NextResponse.json({ error: "Not found", code: "activity_not_found" }, { status: 404 });

    const canEdit = await canActOnEntity(session.user.id, session.user.role, existing.departmentId, "activity.edit");
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    const body = await req.json();
    const data = updateActivitySchema.parse(body);

    // Same shared check regardless of caller (manual edit form, Project
    // Gantt drag, or Resource Planning drag) — computed from whichever of
    // startDate/dueDate this request actually changes, falling back to the
    // stored value for the one it doesn't.
    const effectiveStart = data.startDate !== undefined ? (data.startDate ? new Date(data.startDate) : null) : existing.startDate;
    const effectiveDue = data.dueDate !== undefined ? (data.dueDate ? new Date(data.dueDate) : null) : existing.dueDate;
    if (effectiveStart && effectiveDue && effectiveStart > effectiveDue) {
      return NextResponse.json(
        { error: "Start date cannot be after due date.", code: "invalid_date_range" },
        { status: 400 }
      );
    }

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

    // Moving an activity into a different project (or clearing it back to
    // Standalone) — shared by the Activity edit form's Project dropdown and
    // any other caller of this route. Only validated when the project is
    // actually CHANGING — the edit form always resends the current
    // projectId whether or not the user touched that field, so gating on
    // "present in the payload" alone would re-validate (and could wrongly
    // reject) an unchanged value, e.g. for a legacy activity with no
    // departmentId of its own being compared against its own already-valid
    // project. Clearing to null needs no extra check; moving into a real
    // project requires it to exist and to belong to this activity's own
    // (effective) department — cross-department moves are blocked outright,
    // never silently reparented.
    const projectChanged = data.projectId !== undefined && data.projectId !== existing.projectId;
    if (projectChanged && data.projectId !== null) {
      const targetProject = await prisma.project.findUnique({
        where: { id: data.projectId! },
        select: { id: true, departmentId: true },
      });
      if (!targetProject) {
        return NextResponse.json({ error: "Project not found", code: "project_not_found" }, { status: 404 });
      }
      if (targetProject.departmentId !== effectiveDepartmentId) {
        return NextResponse.json(
          { error: "The selected project belongs to a different department.", code: "invalid_project_scope" },
          { status: 400 }
        );
      }
    }

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

    // Progress is always derived from status (per this department's own
    // configured percentages, see lib/activities/activity-progress.ts) —
    // never accepted from the client (the "progress" field was removed from
    // updateActivitySchema entirely; see lib/validations.ts). Recomputed on
    // every write, not just when status itself changes, so it can never
    // silently drift out of sync with the department's current config.
    const effectiveStatus = data.status ?? existing.status;
    const derivedProgress = await getActivityProgressFromStatus(effectiveDepartmentId, effectiveStatus);

    const activity = await prisma.projectActivity.update({
      where: { id },
      data: {
        ...rest,
        progress: derivedProgress,
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

    // Roll the (now always in-sync) progress up into any affected project's
    // average — the old project (if the activity just moved out of it) and/or
    // the new/current one (status changed, or it moved into a project).
    const statusChanged = data.status !== undefined && data.status !== existing.status;
    if (projectChanged && existing.projectId) {
      recalculateProjectRollup(existing.projectId).catch((err) => {
        console.error("[progress-rollup] old project recalculation failed:", err);
      });
    }
    if ((statusChanged || projectChanged) && activity.project?.id) {
      recalculateProjectRollup(activity.project.id).catch((err) => {
        console.error("[progress-rollup] activity change recalculation failed:", err);
      });
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
