import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canViewAllDepartments, hasDepartmentPermission } from "@/lib/permissions";
import { canActOnEntity, resolveDefaultStatusId } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { changeTicketDepartmentSchema } from "@/lib/validations";

/**
 * The one audited path for moving a Ticket's Department/SubDepartment —
 * ticket-only (never Project/Activity), gated by ticket.department.change
 * rather than the ticket.changeStatus the generic PATCH uses. Kept separate
 * from PATCH /api/tickets/[id] so the department-move permission logic and
 * audit trail live in exactly one place.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      select: {
        id: true,
        departmentId: true,
        subDepartmentId: true,
        shareWithSubDepartment: true,
        categoryId: true,
        priorityId: true,
        statusId: true,
        cancelReasonId: true,
        projectId: true,
        activityId: true,
      },
    });
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found", code: "ticket_not_found" }, { status: 404 });
    }

    const canChange = await canActOnEntity(
      session.user.id,
      session.user.role,
      ticket.departmentId,
      "ticket.department.change",
      false // owner does NOT bypass — only real permission holders may move a ticket
    );
    if (!canChange) {
      return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    const body = await req.json();
    const data = changeTicketDepartmentSchema.parse(body);

    const departmentChanging = data.departmentId !== ticket.departmentId;

    if (departmentChanging && !canViewAllDepartments(session.user.role)) {
      const targetMembership = await getMembership(session.user.id, data.departmentId);
      const allowedInTarget = targetMembership
        ? await hasDepartmentPermission(targetMembership.role, "ticket.department.change", targetMembership.customRoleId)
        : false;
      if (!allowedInTarget) {
        return NextResponse.json(
          { error: "You don't have access to move tickets into the target department", code: "invalid_department" },
          { status: 403 }
        );
      }
    }

    const targetDepartment = await prisma.department.findUnique({ where: { id: data.departmentId }, select: { id: true, name: true } });
    if (!targetDepartment) {
      return NextResponse.json({ error: "Department not found", code: "invalid_department" }, { status: 404 });
    }

    // Resolution order: explicit subDepartmentId (including explicit null,
    // i.e. "clear it") wins; otherwise, a department change invalidates
    // whatever sub-department was set (it belonged to the old department),
    // so it's cleared; otherwise nothing about the sub-department changes.
    const resolvedSubDepartmentId =
      data.subDepartmentId !== undefined ? data.subDepartmentId : departmentChanging ? null : ticket.subDepartmentId;

    if (resolvedSubDepartmentId) {
      const valid = await validateSubDepartmentInDepartment(resolvedSubDepartmentId, data.departmentId);
      if (!valid) {
        return NextResponse.json(
          { error: "The selected sub-department does not belong to the target department.", code: "subdepartment_department_mismatch" },
          { status: 400 }
        );
      }
    }

    // Department changed -> re-validate the ticket's category/priority/
    // status/cancel reason still belong to the target department (or are
    // global) — never silently keep a config value scoped to the OLD
    // department. Category/priority/cancel reason are nullable, so an
    // invalid one just clears; status is required, so it falls back to the
    // target department's own default (or the global default) via the same
    // resolveDefaultStatusId used at ticket creation.
    let resolvedCategoryId = ticket.categoryId;
    let resolvedPriorityId = ticket.priorityId;
    let resolvedStatusId = ticket.statusId;
    let resolvedCancelReasonId = ticket.cancelReasonId;
    let resolvedProjectId = ticket.projectId;
    let resolvedActivityId = ticket.activityId;

    if (departmentChanging) {
      const [category, priority, status, cancelReason, project, activity] = await Promise.all([
        ticket.categoryId ? prisma.ticketCategory.findUnique({ where: { id: ticket.categoryId }, select: { departmentId: true } }) : Promise.resolve(null),
        ticket.priorityId ? prisma.ticketPriority.findUnique({ where: { id: ticket.priorityId }, select: { departmentId: true } }) : Promise.resolve(null),
        prisma.ticketStatus.findUnique({ where: { id: ticket.statusId }, select: { departmentId: true } }),
        ticket.cancelReasonId ? prisma.ticketCancelReason.findUnique({ where: { id: ticket.cancelReasonId }, select: { departmentId: true } }) : Promise.resolve(null),
        ticket.projectId ? prisma.project.findUnique({ where: { id: ticket.projectId }, select: { departmentId: true } }) : Promise.resolve(null),
        ticket.activityId ? prisma.projectActivity.findUnique({ where: { id: ticket.activityId }, select: { departmentId: true, projectId: true } }) : Promise.resolve(null),
      ]);

      const stillValid = (rowDepartmentId: string | null | undefined) =>
        rowDepartmentId == null || rowDepartmentId === data.departmentId;

      if (ticket.categoryId && !stillValid(category?.departmentId)) resolvedCategoryId = null;
      if (ticket.priorityId && !stillValid(priority?.departmentId)) resolvedPriorityId = null;
      if (ticket.cancelReasonId && !stillValid(cancelReason?.departmentId)) resolvedCancelReasonId = null;
      if (!stillValid(status?.departmentId)) {
        const fallbackStatusId = await resolveDefaultStatusId(data.departmentId);
        if (fallbackStatusId) resolvedStatusId = fallbackStatusId;
      }
      // Project/Activity — same leniency, plus the activity must still
      // belong to whichever project survives (if it belonged to one at all).
      if (ticket.projectId && !stillValid(project?.departmentId)) resolvedProjectId = null;
      if (ticket.activityId && !stillValid(activity?.departmentId)) resolvedActivityId = null;
      if (resolvedActivityId && activity?.projectId && activity.projectId !== resolvedProjectId) resolvedActivityId = null;
    }

    const subDepartmentChanging = resolvedSubDepartmentId !== ticket.subDepartmentId;
    if (!departmentChanging && !subDepartmentChanging) {
      // No-op: nothing actually moved — return the ticket as-is, no audit noise.
      const unchanged = await prisma.ticket.findUnique({ where: { id }, include: { department: { select: { id: true, name: true } } } });
      return NextResponse.json(unchanged);
    }

    // Clearing the sub-department also clears "share with my subdepartment"
    // — there's no subdepartment left to share with.
    const clearingSubDepartment = !resolvedSubDepartmentId;

    const [oldDepartment, newSubDepartment, oldSubDepartment] = await Promise.all([
      ticket.departmentId ? prisma.department.findUnique({ where: { id: ticket.departmentId }, select: { name: true } }) : null,
      resolvedSubDepartmentId ? prisma.subDepartment.findUnique({ where: { id: resolvedSubDepartmentId }, select: { name: true } }) : null,
      ticket.subDepartmentId ? prisma.subDepartment.findUnique({ where: { id: ticket.subDepartmentId }, select: { name: true } }) : null,
    ]);

    const describe = (deptName: string | undefined | null, subDeptName: string | undefined | null) =>
      subDeptName ? `${deptName ?? "—"} / ${subDeptName}` : deptName ?? "—";
    const oldDescription = describe(oldDepartment?.name, oldSubDepartment?.name);
    const newDescription = describe(targetDepartment.name, newSubDepartment?.name);

    const now = new Date();
    const updatedTicket = await prisma.ticket.update({
      where: { id },
      data: {
        departmentId: data.departmentId,
        subDepartmentId: resolvedSubDepartmentId,
        shareWithSubDepartment: clearingSubDepartment ? false : ticket.shareWithSubDepartment,
        departmentChangedById: session.user.id,
        departmentChangedAt: now,
        categoryId: resolvedCategoryId,
        priorityId: resolvedPriorityId,
        statusId: resolvedStatusId,
        cancelReasonId: resolvedCancelReasonId,
        projectId: resolvedProjectId,
        activityId: resolvedActivityId,
      },
      include: {
        department: { select: { id: true, name: true } },
        subDepartment: { select: { id: true, name: true } },
        departmentChangedBy: { select: { id: true, name: true, email: true } },
      },
    });

    await prisma.ticketHistory.create({
      data: {
        ticketId: id,
        changedById: session.user.id,
        type: "DEPARTMENT_CHANGE",
        oldValue: oldDescription,
        newValue: newDescription,
        description: `Department changed from "${oldDescription}" to "${newDescription}"`,
      },
    });

    return NextResponse.json(updatedTicket);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
