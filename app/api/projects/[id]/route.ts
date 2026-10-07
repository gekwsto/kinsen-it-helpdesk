import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasDepartmentPermission } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { updateProjectSchema, updateProjectRequestOriginFieldsSchema } from "@/lib/validations";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";
import { publishActivityListInvalidation } from "@/lib/realtime/activity-list-invalidation";
import { computeProjectFinancials } from "@/lib/services/project-financials-service";
import { notifyRequesterOfProjectCompletion } from "@/lib/services/project-feedback-service";
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
  // Included unconditionally (even for a Project with no expenseTypeId at
  // all — Prisma simply returns null) so a now-INACTIVE type a
  // request-origin Project already references still displays by name
  // (never just its bare id) — see this feature's own "existing Project
  // continues displaying a now-inactive Expense Type" requirement.
  expenseType: { select: { id: true, name: true, isActive: true } },
  activities: {
    orderBy: { createdAt: "desc" as const },
    include: {
      assignedUser: { select: { id: true, name: true, image: true } },
    },
  },
};

// Project.budget/estimatedCost/actualCost no longer exist as DB columns —
// Estimated/Actual Cost are injected here instead, computed fresh from this
// SAME request's already-loaded `project.activities` (no extra query) via
// the single authoritative aggregation (lib/services/project-financials-
// service.ts). Harmless to compute for a manual Project too (naturally
// €0/€0, since a manual Activity never has taskTypeCost set) — the UI only
// ever renders these inside its own projectRequest-gated section.
function withProjectFinancials<T extends { activities: { taskTypeCost: any; expectedDays: number | null; actualDays: number | null }[] }>(
  project: T
): T & { estimatedCost: string; actualCost: string } {
  const { estimatedCost, actualCost } = computeProjectFinancials(project.activities);
  return { ...project, estimatedCost: estimatedCost.toString(), actualCost: actualCost.toString() };
}

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

    // Department-scoped, OR (request-origin only) an explicitly-selected
    // Owner/Audience user — see hasProjectViewAccess's own doc comment.
    const canView = await hasProjectViewAccess(session.user.id, session.user.role, session.user.customRoleId, project);
    if (!canView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json(withProjectFinancials(project));
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

    const existing = await prisma.project.findUnique({
      where: { id },
      select: { departmentId: true, status: true, title: true, expectedStartDate: true, expectedFinishDate: true, expenseTypeId: true, projectRequestId: true },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canEdit = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, existing.departmentId, "project.edit");
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    // Merged with the request-origin-only editable fields (Expected
    // Start/Finish, Expense Type, Budget, Estimated Cost, Actual Cost,
    // External) — see that schema's own doc comment for why
    // expectedTotalInitialDays is deliberately never accepted here
    // (creation-time baseline, immutable). Accepted for ANY Project being
    // edited, not just ones with projectRequestId set — the UI only ever
    // OFFERS this block for request-origin Projects (see
    // app/(main)/projects/[id]/edit/page.tsx), but there's no extra
    // security boundary being bypassed by also allowing it here: editing
    // these fields still requires the SAME project.edit this route already
    // re-checks above, on a real, already-existing Project.
    const data = updateProjectSchema.merge(updateProjectRequestOriginFieldsSchema).parse(body);

    // expectedStartDate/expectedFinishDate are now `string | null | undefined`
    // (see updateProjectRequestOriginFieldsSchema's doc comment): `undefined`
    // means "untouched, use whatever's already stored"; `null` (or an empty
    // string, belt-and-suspenders) means "explicitly cleared — there is no
    // date". `new Date(null)` would silently coerce to the 1970 epoch rather
    // than "no date", so that case is handled explicitly instead of ever
    // reaching `new Date(...)`. Both dates are independently optional on
    // edit — the finish>=start rule only applies once BOTH are non-null.
    const effectiveExpectedStart =
      data.expectedStartDate !== undefined ? (data.expectedStartDate ? new Date(data.expectedStartDate) : null) : existing.expectedStartDate;
    const effectiveExpectedFinish =
      data.expectedFinishDate !== undefined ? (data.expectedFinishDate ? new Date(data.expectedFinishDate) : null) : existing.expectedFinishDate;
    if (effectiveExpectedStart && effectiveExpectedFinish && effectiveExpectedFinish < effectiveExpectedStart) {
      return NextResponse.json(
        { error: "Expected Finish Date cannot be before Expected Start Date.", code: "invalid_expected_dates" },
        { status: 400 }
      );
    }

    // expenseTypeId is also `string | null | undefined` on edit — `null`
    // (explicitly cleared) or re-sending the SAME id already on this
    // Project skips validation entirely (the second case is what lets an
    // already-set, since-deactivated Expense Type remain settable/
    // re-settable — e.g. re-saving the edit form without touching this
    // field, or saving an unrelated field while it stays as-is). Only a
    // genuinely NEW selection (a different id than what's already stored)
    // is validated — and, unlike the old behavior, that validation now
    // matches creation time's own rule: it must exist AND be active. This
    // is what stops a since-deactivated Expense Type from being newly
    // chosen on a DIFFERENT Project (or re-chosen after having been
    // cleared) via edit, while still never blocking the Project that
    // already legitimately references it.
    if (data.expenseTypeId !== undefined && data.expenseTypeId !== null && data.expenseTypeId !== existing.expenseTypeId) {
      const expenseType = await prisma.projectExpenseType.findUnique({ where: { id: data.expenseTypeId }, select: { id: true, isActive: true } });
      if (!expenseType || !expenseType.isActive) {
        return NextResponse.json({ error: "The selected Expense Type does not exist or is not active.", code: "invalid_expense_type" }, { status: 400 });
      }
    }

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

    const { memberIds, startDate, endDate, expectedStartDate, expectedFinishDate, ...rest } = data;
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
        // undefined (key omitted) -> leave untouched; null/"" (explicitly
        // cleared) -> persist NULL; a real value -> the parsed Date. Reuses
        // the exact same effective values already computed above for the
        // finish>=start check, so the two can never disagree.
        expectedStartDate: expectedStartDate === undefined ? undefined : effectiveExpectedStart,
        expectedFinishDate: expectedFinishDate === undefined ? undefined : effectiveExpectedFinish,
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

    // Notify the original requester the moment THIS save is what just
    // completed a request-origin Project — never on an unrelated edit of
    // an already-COMPLETED Project, never for a manual one (no
    // projectRequestId). createInAppNotification never throws (failures
    // are only logged), so this can never turn an otherwise-successful
    // PATCH into an error response.
    if (existing.status !== "COMPLETED" && project.status === "COMPLETED" && existing.projectRequestId) {
      await notifyRequesterOfProjectCompletion({ id: project.id, title: project.title, projectRequestId: existing.projectRequestId });
    }

    return NextResponse.json(withProjectFinancials(project));
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
