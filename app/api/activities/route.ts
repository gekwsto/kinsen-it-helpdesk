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
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { createActivitySchema, requestOriginActivityMissingFields } from "@/lib/validations";
import { getActivityProgressFromStatus, ActivityProgressConfigurationError } from "@/lib/activities/activity-progress";
import { recalculateProjectRollup } from "@/lib/projects/progress-rollup";
import { publishActivityListInvalidation } from "@/lib/realtime/activity-list-invalidation";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";
import { wholeCalendarDaysBetween, actualDaysFromCompletion } from "@/lib/date-only";
import { computeActivityFinancials } from "@/lib/services/project-financials-service";
import { getAppendSequenceLocked } from "@/lib/services/activity-sequence-service";
import { ActivityStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);

    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");
    const assignedUserId = searchParams.get("assignedUserId");
    const departmentId = searchParams.get("departmentId");
    const subDepartmentId = searchParams.get("subDepartmentId");

    const scope = await buildActivityListWhere(session.user.id, session.user.role, departmentId);
    if ("denied" in scope) {
      return NextResponse.json({ error: "You don't have access to this department" }, { status: 403 });
    }

    const andConditions: any[] = [scope];
    if (subDepartmentId) andConditions.push({ subDepartmentId });
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
    // The authoritative, server-resolved provenance check this entire
    // feature hinges on — NEVER a client flag. Every Activity creation path
    // goes through this one route (see lib/validations.ts's
    // createActivitySchema doc comment), so this is the single place the
    // rule needs to live.
    let isRequestOriginProject = false;
    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
        select: { departmentId: true, projectRequestId: true },
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
      isRequestOriginProject = project.projectRequestId !== null;
    }

    // Task Type (see TaskType in prisma/schema.prisma) is REQUIRED for
    // EVERY Activity, manual or request-origin alike — enforced by
    // createActivitySchema itself (a missing/empty taskTypeId already
    // fails .parse() above with a 422, before this line is ever reached).
    // Task Sub Type/Owner/dates/Related Users remain conditionally
    // required ONLY for request-origin Activities, via
    // requestOriginActivityMissingFields below — completely unchanged by
    // this feature.
    if (isRequestOriginProject) {
      const missing = requestOriginActivityMissingFields(data);
      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: "This Activity's parent Project originates from a Project Request — Expected Start, Expected Finish, Task Sub Type, Owner, and at least one Related User are required.",
            code: "request_origin_fields_required",
            missingFields: missing,
          },
          { status: 400 }
        );
      }
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

    const {
      dueDate,
      startDate,
      assignedUserIds,
      departmentId: _ignoredDepartmentId,
      isCompleted: _ignoredIsCompleted,
      expectedStartDate,
      expectedFinishDate,
      ownerId,
      taskTypeId,
      taskSubTypeId,
      manualEstimatedCost,
      ...rest
    } = data;

    if (rest.subDepartmentId) {
      const valid = await validateSubDepartmentInDepartment(rest.subDepartmentId, deptResolution.departmentId);
      if (!valid) {
        return NextResponse.json(
          { error: "The selected sub-department does not belong to this activity's department.", code: "subdepartment_department_mismatch" },
          { status: 400 }
        );
      }
    }

    if (assignedUserIds.length > 0) {
      // Deduplicated server-side — the dropdown already prevents picking the
      // same user twice, but a caller going around the UI must not be able
      // to send e.g. the same id 3 times and have it connect() 3 times (a
      // no-op for a many-to-many relation, but validated here regardless so
      // the eligibility loop below never does redundant work).
      const uniqueAssignedUserIds = Array.from(new Set(assignedUserIds));
      for (const userId of uniqueAssignedUserIds) {
        const assignable = await userHasAssignablePermissionForEntity(userId, "activity", deptResolution.departmentId);
        if (!assignable) {
          return NextResponse.json(
            { error: "One or more selected users cannot be assigned to activities in this department.", code: "assignee_not_assignable" },
            { status: 400 }
          );
        }
      }
    }

    // Owner — the SAME eligibility rule as assignedUsers/Related Users
    // above (userHasAssignablePermissionForEntity), never a bare id lookup.
    // Validated whenever supplied, not only for a request-origin Project —
    // a manual Project's Activity may optionally set it too, with the same
    // server-side guarantee.
    if (ownerId) {
      const ownerAssignable = await userHasAssignablePermissionForEntity(ownerId, "activity", deptResolution.departmentId);
      if (!ownerAssignable) {
        return NextResponse.json(
          { error: "The selected Owner is not a valid user for Activities in this department.", code: "invalid_owner" },
          { status: 400 }
        );
      }
    }

    // Task Type (the NEW classification — see TaskType in
    // prisma/schema.prisma) — REQUIRED (createActivitySchema already
    // guarantees a non-empty string reached this line), must exist AND be
    // currently active. Never trusted from the client beyond its id. Has
    // NO cost of its own — nothing to snapshot here.
    const taskType = await prisma.taskType.findUnique({ where: { id: taskTypeId }, select: { id: true, isActive: true } });
    if (!taskType || !taskType.isActive) {
      return NextResponse.json(
        { error: "The selected Task Type does not exist or is not active.", code: "invalid_task_type" },
        { status: 400 }
      );
    }

    // Task Sub Type (the RENAMED former "Task Type" — see TaskSubType in
    // prisma/schema.prisma) — must exist AND be currently active, same
    // creation-time rule as Project's own Expense Type at setup time (see
    // createProjectFromApprovedRequest). Cost resolution: when the
    // resolved row has a CONFIGURED cost, that value is always what gets
    // snapshotted — never a client-submitted value, never overridable via
    // manualEstimatedCost (silently ignored in that case). When the
    // resolved row has NO configured cost (cost === null — e.g. "Others"/
    // "External"), a manualEstimatedCost is REQUIRED and becomes this
    // Activity's own snapshot instead — validated as a real, non-negative
    // Decimal by createActivitySchema already, never trusted beyond that.
    // This manual value is NEVER written back to TaskSubType.cost — it
    // belongs only to this Activity.
    let taskSubTypeCostSnapshot: number | null | undefined;
    if (taskSubTypeId) {
      const taskSubType = await prisma.taskSubType.findUnique({ where: { id: taskSubTypeId }, select: { id: true, isActive: true, cost: true } });
      if (!taskSubType || !taskSubType.isActive) {
        return NextResponse.json(
          { error: "The selected Task Sub Type does not exist or is not active.", code: "invalid_task_sub_type" },
          { status: 400 }
        );
      }
      if (taskSubType.cost !== null) {
        taskSubTypeCostSnapshot = Number(taskSubType.cost);
      } else if (manualEstimatedCost !== undefined) {
        taskSubTypeCostSnapshot = manualEstimatedCost;
      } else {
        return NextResponse.json(
          { error: "Enter an Estimated Cost — the selected Task Sub Type has no fixed configured cost.", code: "estimated_cost_required" },
          { status: 400 }
        );
      }
    }

    if (expectedStartDate && expectedFinishDate && new Date(expectedFinishDate) < new Date(expectedStartDate)) {
      return NextResponse.json(
        { error: "Expected Finish cannot be before Expected Start.", code: "invalid_expected_dates" },
        { status: 400 }
      );
    }

    // Server-authoritative, never a client-submitted value (expectedDays
    // isn't even a field on createActivitySchema). Null unless BOTH dates
    // are present — a legacy/partial record with only one of the two never
    // gets a fabricated duration.
    const expectedDays =
      expectedStartDate && expectedFinishDate
        ? wholeCalendarDaysBetween(new Date(expectedStartDate), new Date(expectedFinishDate))
        : null;

    // Computed BEFORE the create, and never caught-and-substituted: a
    // missing/disabled ActivityProgressConfig row for this department+status
    // rejects the whole request (configuration_required) rather than
    // persisting an activity with a fabricated progress percentage.
    let progress: number;
    try {
      progress = await getActivityProgressFromStatus(deptResolution.departmentId, rest.status);
    } catch (err) {
      if (err instanceof ActivityProgressConfigurationError) {
        return NextResponse.json(
          { error: `No progress configuration exists for status "${rest.status}" in this department. Ask an admin to configure it under Activity Progress before creating activities with this status.`, code: "configuration_required" },
          { status: 409 }
        );
      }
      throw err;
    }

    // isCompleted/completedAt/actualDays are derived HERE from `rest.status`
    // alone — never from a client-sent isCompleted (which createActivitySchema
    // still accepts but this route now ignores for this purpose; see
    // PATCH /api/activities/[id]'s own identical fix for why: a client flag
    // and the real status could otherwise silently drift apart). An Activity
    // CAN be created directly in COMPLETED status (e.g. logging already-done
    // work) — this is the authoritative transition boundary for that case
    // too, not just for a later PATCH.
    const createdAsCompleted = rest.status === ActivityStatus.COMPLETED;
    const completionDate = createdAsCompleted ? new Date() : null;
    const actualDays =
      createdAsCompleted && expectedStartDate ? actualDaysFromCompletion(new Date(expectedStartDate), completionDate!) : null;

    // Sequence (request-origin Projects only) — the server-derived APPEND
    // position, never client-authoritative (createActivitySchema doesn't
    // even accept a sequence field). Locking the Project row and computing
    // the append position happen in the SAME transaction as the create
    // itself, so two concurrent creates under the same Project can never
    // both land on the same position — the second always sees the first's
    // already-committed row once its own lock is granted. A Standalone
    // Activity or one under a manual Project simply never gets a sequence
    // at all (stays null, exactly like today).
    const activity = await prisma.$transaction(async (tx) => {
      const sequence = isRequestOriginProject && data.projectId ? await getAppendSequenceLocked(tx, data.projectId) : undefined;
      return tx.projectActivity.create({
        data: {
          ...rest,
          progress,
          departmentId: deptResolution.departmentId,
          startDate: startDate ? new Date(startDate) : undefined,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          createdById: session.user.id,
          ownerId: ownerId || undefined,
          taskTypeId,
          taskSubTypeId: taskSubTypeId || undefined,
          taskSubTypeCost: taskSubTypeCostSnapshot,
          expectedStartDate: expectedStartDate ? new Date(expectedStartDate) : undefined,
          expectedFinishDate: expectedFinishDate ? new Date(expectedFinishDate) : undefined,
          expectedDays,
          isCompleted: createdAsCompleted,
          completedAt: completionDate,
          actualDays,
          sequence,
          assignedUsers: assignedUserIds.length
            ? { connect: Array.from(new Set(assignedUserIds)).map((id) => ({ id })) }
            : undefined,
        },
        include: {
          project: { select: { id: true, title: true } },
          assignedUsers: { select: { id: true, name: true, email: true, image: true } },
          owner: { select: { id: true, name: true, email: true, image: true } },
          taskType: { select: { id: true, name: true } },
          taskSubType: { select: { id: true, name: true } },
        },
      });
    });

    // AWAITED (not fire-and-forget) — same fix/rationale as PATCH
    // /api/activities/[id]'s own rollup call: a fire-and-forget version here
    // could let the realtime publish below (and the client's own
    // router.refresh() it triggers) race ahead of the rollup's
    // prisma.project.update(), rendering a stale Project.progress in
    // /my-projects. Never allowed to fail the activity create itself — a
    // rollup error is caught and logged, not thrown.
    if (activity.projectId) {
      await recalculateProjectRollup(activity.projectId).catch((err) => {
        console.error("[progress-rollup] activity create recalculation failed:", err);
        return null;
      });
    }

    // Published only after the create (and, if applicable, the project
    // rollup) has actually committed above. The new activity needs to
    // appear in every open, matching Activity list.
    publishActivityListInvalidation();
    // Cross-entity: a new activity under a project changes that project's
    // visible `_count.activities` (and, once resolved.length > 0, its
    // progress rollup) — refresh the Project list too.
    if (activity.projectId) {
      publishProjectListInvalidation();
    }

    const { estimatedCost, actualCost } = computeActivityFinancials(activity);
    return NextResponse.json({ ...activity, estimatedCost: estimatedCost.toString(), actualCost: actualCost.toString() }, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
