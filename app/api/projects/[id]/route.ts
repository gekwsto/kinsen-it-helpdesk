import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasDepartmentPermission } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { updateProjectSchema } from "@/lib/validations";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";
import { publishActivityListInvalidation } from "@/lib/realtime/activity-list-invalidation";
import { Role } from "@prisma/client";

// Every field the Project List (table) or Grid (card) view actually
// renders, or that any real Project-list page's filters/sorting/scope
// keys off (see components/projects/project-list.tsx,
// app/(main)/my-projects/page.tsx, app/(main)/projects/page.tsx's
// PROJECT_SORT_KEYS and subDepartmentId filter). Deliberately excludes
// businessUnitId, successTarget and isGoal — none of those are rendered,
// filtered, or sorted on by any real Project list page today (confirmed by
// grep across project-list.tsx/my-projects/page.tsx/projects/page.tsx).
const PROJECT_LIST_RELEVANT_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "departmentId",
  "subDepartmentId",
  "startDate",
  "endDate",
  "memberIds",
] as const;

const PROJECT_INCLUDE = {
  owner: { select: { id: true, name: true, email: true, image: true } },
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
  members: { select: { id: true, name: true, email: true, image: true } },
  activities: {
    orderBy: { createdAt: "desc" as const },
    include: {
      assignedUser: { select: { id: true, name: true, image: true } },
    },
  },
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const project = await prisma.project.findUnique({
      where: { id },
      include: PROJECT_INCLUDE,
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // hasEffectiveEntityPermission (global grant OR this entity's own department
    // grant) — bare canActOnEntity ignored a global role/custom-role project.view.
    // Department is the real row's, never the workspace or the client.
    const canView = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.view");
    if (!canView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json(project);
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

    const existing = await prisma.project.findUnique({ where: { id }, select: { departmentId: true, status: true, title: true } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canEdit = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, existing.departmentId, "project.edit");
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const data = updateProjectSchema.parse(body);

    // Moving a project into a different department requires standing there too.
    if (data.departmentId !== undefined && data.departmentId !== null && data.departmentId !== existing.departmentId) {
      if (session.user.role !== Role.ADMIN) {
        const targetMembership = await getMembership(session.user.id, data.departmentId);
        const allowed = targetMembership
          ? await hasDepartmentPermission(targetMembership.role, "project.create", targetMembership.customRoleId)
          : false;
        if (!allowed) {
          return NextResponse.json({ error: "You don't have access to the target department" }, { status: 403 });
        }
      }
    }

    const { memberIds, startDate, endDate, ...rest } = data;
    const effectiveDepartmentId = data.departmentId !== undefined ? data.departmentId : existing.departmentId;

    if (memberIds && memberIds.length > 0) {
      for (const userId of memberIds) {
        const assignable = await userHasAssignablePermissionForEntity(userId, "project", effectiveDepartmentId);
        if (!assignable) {
          return NextResponse.json(
            { error: "One or more selected members cannot be assigned to projects in this department.", code: "assignee_not_assignable" },
            { status: 400 }
          );
        }
      }
    }

    if (rest.subDepartmentId) {
      const valid = await validateSubDepartmentInDepartment(rest.subDepartmentId, effectiveDepartmentId);
      if (!valid) {
        return NextResponse.json(
          { error: "The selected sub-department does not belong to this project's department.", code: "subdepartment_department_mismatch" },
          { status: 400 }
        );
      }
    }

    // Department changed but no explicit new sub-department was given — the
    // stale one (if any) can no longer be valid, so it's cleared.
    const departmentChanging = data.departmentId !== undefined && data.departmentId !== existing.departmentId;
    const clearStaleSubDepartment = departmentChanging && rest.subDepartmentId === undefined;

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...rest,
        subDepartmentId: clearStaleSubDepartment ? null : rest.subDepartmentId,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        members: memberIds
          ? { set: memberIds.map((memberId) => ({ id: memberId })) }
          : undefined,
      },
      include: PROJECT_INCLUDE,
    });

    // Publish ONLY after the update has actually committed above — never
    // before. One coalesced publish per request regardless of how many
    // list-relevant fields changed together (a compound PATCH never fires
    // more than once here). Fire-and-forget/non-blocking: a realtime
    // publish failure must never fail (or even slow down) a mutation that
    // already succeeded. See lib/realtime/project-list-invalidation.ts's
    // doc comment for why this is a separate channel from tickets'/
    // activities', reusing the same established LISTEN/NOTIFY + SSE +
    // debounced router.refresh() mechanism.
    if (PROJECT_LIST_RELEVANT_FIELDS.some((field) => data[field] !== undefined)) {
      publishProjectListInvalidation();
    }

    // Cross-entity: the Activity List/Grid views render `activity.project.title`
    // for every linked activity — a rename must refresh those lists too, or
    // they'd keep showing the project's old name until an unrelated refresh.
    // Gated on an ACTUAL value change (not just "title present in the
    // payload") since this is the one cross-entity case cheap to diff
    // precisely against `existing` fetched above. Department/other Project
    // field changes are deliberately NOT propagated to the Activity list:
    // an Activity's own `departmentId` is an independent field, never
    // derived from its parent Project's, so moving a Project between
    // departments doesn't change anything the Activity list itself renders,
    // filters, or scopes on.
    if (data.title !== undefined && data.title !== existing.title) {
      publishActivityListInvalidation();
    }

    return NextResponse.json(project);
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
    const session = await requireAuth();

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, departmentId: true, _count: { select: { activities: true } } },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Department-scoped, same resolver as GET/PATCH above — project.delete
    // is its own permission (DEPARTMENT_ADMIN has it granted independently
    // of project.edit; see prisma/seed.ts), never inferred from
    // project.edit and never requiring global Role.ADMIN. canActOnEntity's
    // own canViewAllDepartments(role) bypass keeps a real System Admin's
    // behavior exactly as it was.
    const canDelete = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, project.departmentId, "project.delete");
    if (!canDelete) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Safe cascade behaviour (no migration needed):
    //   Ticket.projectId        → nullable, DB SetNull default
    //   ProjectActivity.projectId → onDelete: SetNull (explicit in schema)
    //   _ProjectMembers join rows → DB CASCADE (implicit M2M)
    //   _GoalProjects join rows   → DB CASCADE (implicit M2M)
    await prisma.project.delete({ where: { id } });

    // The deleted project disappears from every Project list.
    publishProjectListInvalidation();
    // Cross-entity: any activity that belonged to this project just had its
    // projectId SetNull'd (never cascade-deleted) — the Activity List's
    // "Project" column for each of them now shows "Standalone" instead of
    // this project's title, so those lists need refreshing too. Only
    // published when this project actually had linked activities.
    if (project._count.activities > 0) {
      publishActivityListInvalidation();
    }

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
