import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasDepartmentPermission } from "@/lib/permissions";
import { canActOnEntity, hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { updateActivitySchema, requestOriginActivityMissingFields } from "@/lib/validations";
import { recalculateProjectRollup, type ProjectRollupResult } from "@/lib/projects/progress-rollup";
import { tryGetActivityProgressFromStatus, getActivityProgressFromStatus, ActivityProgressConfigurationError } from "@/lib/activities/activity-progress";
import { getActivityStatusDisplay } from "@/lib/services/activity-status-config";
import { getDefaultLegacyDepartmentId } from "@/lib/services/department-service";
import { publishActivityListInvalidation } from "@/lib/realtime/activity-list-invalidation";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";
import { wholeCalendarDaysBetween, actualDaysFromCompletion } from "@/lib/date-only";
import { computeActivityFinancials } from "@/lib/services/project-financials-service";
import { getAppendSequenceLocked, normalizeProjectSequenceLocked, isRequestOriginProject } from "@/lib/services/activity-sequence-service";
import { Role, ActivityStatus } from "@prisma/client";

// Every field the Activity List (table) or Grid (card) view actually
// renders, or that any real Activity-list page's filters/sorting/scope
// keys off (see components/activities/activity-list.tsx,
// app/(main)/my-activities/page.tsx, app/(main)/activities/page.tsx's
// ACTIVITY_SORT_KEYS and projectId/subDepartmentId/assignedUserId filters —
// GET /api/activities also filters by subDepartmentId, matching Projects).
// Deliberately excludes description, isMilestone and businessUnitId — none
// of those are rendered, filtered, or sorted on by any real Activity list
// page today. `progress` is always re-derived below regardless of what's in
// this list (see derivedProgress), so it doesn't need its own entry here.
const ACTIVITY_LIST_RELEVANT_FIELDS = [
  "title",
  "projectId",
  "departmentId",
  "subDepartmentId",
  "status",
  "priority",
  "assignedUserIds",
  "startDate",
  "dueDate",
  "isCompleted",
] as const;

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
        project: { select: { id: true, title: true, projectRequestId: true } },
        assignedUsers: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true, email: true, image: true } },
        taskType: { select: { id: true, name: true } },
      },
    });

    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // hasEffectiveEntityPermission (global grant OR this entity's own department
    // grant) — bare canActOnEntity ignored a global role/custom-role activity.view.
    // Department is the real row's, never the workspace or the client.
    const canView = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, activity.departmentId, "activity.view");
    if (!canView) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Recomputed fresh against the department's CURRENT config, not just the
    // last-written stored value — so an admin's later percentage edit shows
    // up immediately without needing the activity's status to change again.
    // Never fabricated: a gap resolves to progress:null + progressConfigError,
    // which the detail view renders as an explicit "Configuration required"
    // state instead of a fake percentage.
    const resolution = await tryGetActivityProgressFromStatus(activity.departmentId, activity.status);
    const progress = resolution.ok ? resolution.percent : null;
    const progressConfigError = resolution.ok ? null : { reason: resolution.reason };
    const statusDisplay = await getActivityStatusDisplay(activity.departmentId, activity.status);

    // Lets the Edit Activity client know whether to offer "+ New Project"
    // without a second round-trip — same canActOnEntity gate POST
    // /api/projects itself enforces (via resolveDepartmentForCreate), this
    // is only ever a UI hint; the backend remains the authoritative check.
    const canCreateProjectInDept = await canActOnEntity(session.user.id, session.user.role, activity.departmentId, "project.create");

    // Lets the Activity detail client know whether to offer the Notes
    // composer and the quick-status dropdown without a second round-trip —
    // POST /api/activities/[id]/notes and PATCH /api/activities/[id]
    // independently re-check activity.edit and are the actual authority;
    // this is only ever a UI hint, shared by both controls since they need
    // the exact same permission.
    const canEditActivity = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, activity.departmentId, "activity.edit");

    // Lets the Activity detail client know whether to render the Delete
    // control without a second round-trip — DELETE /api/activities/[id]
    // independently re-checks activity.delete and is the actual authority;
    // this is only ever a UI hint. Deliberately its OWN hasEffectiveEntityPermission call
    // (never derived from canEditActivity above): activity.delete is a
    // separate, independently-grantable permission (see prisma/seed.ts —
    // DEPARTMENT_ADMIN has both, but they are not implied by each other),
    // so edit access must never be treated as delete access.
    const canDeleteActivity = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, activity.departmentId, "activity.delete");

    // The SAME fallback tryGetActivityProgressFromStatus/getActivityStatusDisplay
    // already applied internally, exposed explicitly — a legacy Activity
    // with departmentId: null still resolves its status/progress config
    // through the configured legacy department (never a gap, never
    // "no department"). Without this, the client has no way to know WHICH
    // department's status list to fetch for such an Activity (its own raw
    // `departmentId` is null) and silently never fetches one at all — the
    // root cause of the empty Quick Status dropdown for these Activities.
    // Standalone-vs-legacy are different concepts: `projectId: null` means
    // no parent Project; `departmentId: null` means a pre-department-scoping
    // row that still needs a real department to resolve status config
    // against — this field lets every client-side consumer (Quick Status,
    // Activity Edit) fetch the correct one without re-deriving the fallback
    // themselves.
    const effectiveDepartmentId = activity.departmentId ?? (await getDefaultLegacyDepartmentId());

    // Estimated/Actual Cost — derived here (never stored), reusing the SAME
    // computeActivityFinancials used by Project-level aggregation (see
    // lib/services/project-financials-service.ts). Harmless for a manual
    // Activity too (naturally €0/€0, since taskTypeCost is never set there).
    const { estimatedCost, actualCost } = computeActivityFinancials(activity);

    return NextResponse.json({ ...activity, estimatedCost: estimatedCost.toString(), actualCost: actualCost.toString(), progress, progressConfigError, statusLabel: statusDisplay.label, statusColor: statusDisplay.color, canCreateProjectInDept, canEditActivity, canDeleteActivity, effectiveDepartmentId });
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
      select: {
        departmentId: true,
        startDate: true,
        dueDate: true,
        status: true,
        projectId: true,
        expectedStartDate: true,
        expectedFinishDate: true,
        ownerId: true,
        taskTypeId: true,
      },
    });
    if (!existing) return NextResponse.json({ error: "Not found", code: "activity_not_found" }, { status: 404 });

    const canEdit = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, existing.departmentId, "activity.edit");
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

    const {
      dueDate,
      startDate,
      isCompleted,
      assignedUserIds,
      expectedStartDate,
      expectedFinishDate,
      ownerId,
      taskTypeId,
      ...rest
    } = data;
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
    // Set only in the "moving INTO a real project" branch below — used
    // after this whole validation block to decide this Activity's new
    // `sequence` (see the sequence computation further down).
    let targetProjectIsRequestOrigin = false;
    if (projectChanged && data.projectId !== null) {
      const targetProject = await prisma.project.findUnique({
        where: { id: data.projectId! },
        select: { id: true, departmentId: true, projectRequestId: true },
      });
      if (!targetProject) {
        return NextResponse.json({ error: "Project not found", code: "project_not_found" }, { status: 404 });
      }
      targetProjectIsRequestOrigin = targetProject.projectRequestId !== null;
      if (targetProject.departmentId !== effectiveDepartmentId) {
        return NextResponse.json(
          { error: "The selected project belongs to a different department.", code: "invalid_project_scope" },
          { status: 400 }
        );
      }

      // Relinking an Activity INTO a request-origin Project must never
      // bypass the same invariant creation enforces — block the relink
      // (never silently relaxed) until the resulting Activity would have
      // every required field, using THIS SAME request's own values where
      // supplied (so an edit that moves the project AND fills in the
      // missing metadata in one go is allowed) and the Activity's current
      // stored values otherwise.
      if (targetProject.projectRequestId !== null) {
        const currentAssigneeCount = await prisma.projectActivity
          .findUnique({ where: { id }, select: { _count: { select: { assignedUsers: true } } } })
          .then((row) => row?._count.assignedUsers ?? 0);
        const missing = requestOriginActivityMissingFields({
          expectedStartDate: expectedStartDate !== undefined ? expectedStartDate : existing.expectedStartDate?.toISOString(),
          expectedFinishDate: expectedFinishDate !== undefined ? expectedFinishDate : existing.expectedFinishDate?.toISOString(),
          taskTypeId: taskTypeId !== undefined ? taskTypeId : existing.taskTypeId,
          ownerId: ownerId !== undefined ? ownerId : existing.ownerId,
          assignedUserIds: assignedUserIds !== undefined ? assignedUserIds : currentAssigneeCount > 0 ? ["__existing__"] : [],
        });
        if (missing.length > 0) {
          return NextResponse.json(
            {
              error: "This Project originates from a Project Request — moving this Activity into it requires Expected Start, Expected Finish, Task Type, Owner, and at least one Related User. Supply the missing fields in the same request, or complete them first.",
              code: "request_origin_fields_required",
              missingFields: missing,
            },
            { status: 400 }
          );
        }
      }
    }

    if (assignedUserIds && assignedUserIds.length > 0) {
      for (const userId of Array.from(new Set(assignedUserIds))) {
        const assignable = await userHasAssignablePermissionForEntity(userId, "activity", effectiveDepartmentId);
        if (!assignable) {
          return NextResponse.json(
            { error: "One or more selected users cannot be assigned to activities in this department.", code: "assignee_not_assignable" },
            { status: 400 }
          );
        }
      }
    }

    // Owner — same eligibility rule as assignedUsers above, validated
    // whenever a NEW (non-null) value is actually supplied.
    if (ownerId) {
      const ownerAssignable = await userHasAssignablePermissionForEntity(ownerId, "activity", effectiveDepartmentId);
      if (!ownerAssignable) {
        return NextResponse.json(
          { error: "The selected Owner is not a valid user for Activities in this department.", code: "invalid_owner" },
          { status: 400 }
        );
      }
    }

    // Task Type — only re-validated (must exist AND be active) when
    // GENUINELY changing to a different id, the same "re-saving an
    // already-set, since-deactivated reference value is fine; picking a
    // NEW one must be active" rule this repo's Project Expense Type PATCH
    // already established. Unchanged (including resending the same id, or
    // omitting the field) never touches taskTypeCost's historical snapshot
    // below.
    let newTaskTypeCost: number | undefined;
    const taskTypeChanging = taskTypeId !== undefined && taskTypeId !== existing.taskTypeId;
    if (taskTypeChanging && taskTypeId !== null) {
      const taskType = await prisma.activityTaskType.findUnique({ where: { id: taskTypeId! }, select: { id: true, isActive: true, cost: true } });
      if (!taskType || !taskType.isActive) {
        return NextResponse.json(
          { error: "The selected Task Type does not exist or is not active.", code: "invalid_task_type" },
          { status: 400 }
        );
      }
      newTaskTypeCost = Number(taskType.cost);
    }

    // Expected Start/Finish — independently optional on edit (neither
    // forces the other), finish>=start enforced only once BOTH effective
    // values are real dates, exactly like Project's own
    // expectedFinishDate>=expectedStartDate edit-time rule.
    const effectiveExpectedStart =
      expectedStartDate !== undefined ? (expectedStartDate ? new Date(expectedStartDate) : null) : existing.expectedStartDate;
    const effectiveExpectedFinish =
      expectedFinishDate !== undefined ? (expectedFinishDate ? new Date(expectedFinishDate) : null) : existing.expectedFinishDate;
    if (effectiveExpectedStart && effectiveExpectedFinish && effectiveExpectedFinish < effectiveExpectedStart) {
      return NextResponse.json(
        { error: "Expected Finish cannot be before Expected Start.", code: "invalid_expected_dates" },
        { status: 400 }
      );
    }
    // Recomputed (NOT an immutable baseline, unlike Project.expectedTotalInitialDays)
    // only when either date is actually touched by this request — reusing
    // the same effective values the check above just computed, so the two
    // can never disagree.
    const expectedDaysChanging = expectedStartDate !== undefined || expectedFinishDate !== undefined;
    const newExpectedDays = effectiveExpectedStart && effectiveExpectedFinish ? wholeCalendarDaysBetween(effectiveExpectedStart, effectiveExpectedFinish) : null;

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
    // silently drift out of sync with the department's current config. A
    // missing/disabled config row for the target status/department rejects
    // the whole update (configuration_required) rather than persisting a
    // fabricated percentage — this also means a status can never be moved
    // INTO a gap through a normal edit, PATCH-driven Gantt drag, or
    // Resource Planning drag.
    const effectiveStatus = data.status ?? existing.status;
    let derivedProgress: number;
    try {
      derivedProgress = await getActivityProgressFromStatus(effectiveDepartmentId, effectiveStatus);
    } catch (err) {
      if (err instanceof ActivityProgressConfigurationError) {
        return NextResponse.json(
          { error: `No progress configuration exists for status "${effectiveStatus}" in this department. Ask an admin to configure it under Activity Progress before using this status.`, code: "configuration_required" },
          { status: 409 }
        );
      }
      throw err;
    }

    // THE authoritative COMPLETED-transition boundary — isCompleted and
    // completedAt are derived HERE from the real status transition, never
    // from the client-sent `isCompleted` flag (which updateActivitySchema
    // still accepts, for the consistency pre-check above, but this write no
    // longer trusts directly — see this route's own audit finding: the OLD
    // behavior let isCompleted/completedAt silently drift out of sync with
    // status whenever a caller, like the Activity edit form, sent `status`
    // without also sending `isCompleted`). actualDays is computed ONLY at
    // the moment of a genuine TODO/IN_PROGRESS/etc. -> COMPLETED transition
    // (never retroactively just because expectedStartDate is edited while
    // already completed), using Expected Start (never Expected Finish) and
    // the server's own clock (never a client-submitted date). Reopening
    // (COMPLETED -> anything else) clears it; completing again later
    // recomputes it fresh from the NEW completion date — this repository's
    // Activity domain does allow COMPLETED -> another status (no DB/service
    // guard forbids it; see ActivityStatus's own enum and the quick-status
    // dropdown, which offers every status unconditionally), so this project
    // deliberately implements the reopen-clears/recompute-on-recomplete
    // behavior rather than the "forbidden to reopen" alternative.
    const justCompleted = existing.status !== ActivityStatus.COMPLETED && effectiveStatus === ActivityStatus.COMPLETED;
    const justReopened = existing.status === ActivityStatus.COMPLETED && effectiveStatus !== ActivityStatus.COMPLETED;
    const completionDate = justCompleted ? new Date() : null;
    const newActualDays = justCompleted && effectiveExpectedStart ? actualDaysFromCompletion(effectiveExpectedStart, completionDate!) : null;

    // Sequence — ONLY touched when the PROJECT itself is changing (a plain
    // field edit, status change, etc. never alters it; reordering within a
    // Project has its own dedicated PATCH /api/projects/[id]/activities/order
    // endpoint, never this route). Moving INTO a request-origin Project
    // appends to its end; moving OUT to Standalone or a manual Project
    // clears it (sequence is meaningless there). `undefined` leaves the
    // stored value untouched, matching every other field's convention on
    // this route.
    const newSequence: number | null | undefined = !projectChanged ? undefined : targetProjectIsRequestOrigin ? undefined : null;

    const activity = await prisma.$transaction(async (tx) => {
      // The lock + append-position computation happen in the SAME
      // transaction as the write below, so two concurrent moves into the
      // same Project can never land on the same position.
      const appendSequence = projectChanged && targetProjectIsRequestOrigin ? await getAppendSequenceLocked(tx, data.projectId!) : undefined;
      return tx.projectActivity.update({
        where: { id },
        data: {
          ...rest,
          progress: derivedProgress,
          subDepartmentId: clearStaleSubDepartment ? null : rest.subDepartmentId,
          startDate: startDate ? new Date(startDate) : startDate === null ? null : undefined,
          dueDate: dueDate ? new Date(dueDate) : dueDate === null ? null : undefined,
          isCompleted: effectiveStatus === ActivityStatus.COMPLETED,
          completedAt: justCompleted ? completionDate : justReopened ? null : undefined,
          actualDays: justCompleted ? newActualDays : justReopened ? null : undefined,
          ownerId: ownerId !== undefined ? ownerId : undefined,
          taskTypeId: taskTypeId !== undefined ? taskTypeId : undefined,
          taskTypeCost: taskTypeId === null ? null : taskTypeChanging ? newTaskTypeCost : undefined,
          expectedStartDate: expectedStartDate !== undefined ? effectiveExpectedStart : undefined,
          expectedFinishDate: expectedFinishDate !== undefined ? effectiveExpectedFinish : undefined,
          expectedDays: expectedDaysChanging ? newExpectedDays : undefined,
          sequence: appendSequence ?? newSequence,
          ...(assignedUserIds !== undefined && {
            assignedUsers: { set: Array.from(new Set(assignedUserIds)).map((uid) => ({ id: uid })) },
          }),
        },
        include: {
          project: { select: { id: true, title: true } },
          assignedUsers: { select: { id: true, name: true, email: true, image: true } },
          owner: { select: { id: true, name: true, email: true, image: true } },
          taskType: { select: { id: true, name: true } },
        },
      });
    });

    // The OLD Project's own sequence must never show a gap once this
    // Activity has moved out of it — normalized in its own transaction
    // (separately from the move itself; eventual-consistency here is fine,
    // same as the DELETE handler's own normalize-after-delete) right after
    // the move has committed.
    if (projectChanged && existing.projectId && (await isRequestOriginProject(existing.projectId))) {
      await prisma.$transaction((tx) => normalizeProjectSequenceLocked(tx, existing.projectId!));
    }

    // Roll the (now always in-sync) progress up into any affected project's
    // average — the old project (if the activity just moved out of it) and/or
    // the new/current one (status changed, or it moved into a project).
    //
    // AWAITED (not fire-and-forget): a previous fire-and-forget version of
    // this raced the client's own router.refresh(), which regularly won and
    // rendered stale Project progress. Awaiting means the rollup's own
    // prisma.project.update() has always committed before this route's
    // response is sent — and, now, its RESULT (not just the fact that it
    // ran) is returned in the response body below, so a caller never needs
    // a second round-trip (a refetch/refresh) just to learn what the rollup
    // produced. Still never allowed to fail the activity update itself — a
    // rollup error is caught and logged, not thrown; a settled-but-failed
    // rollup is simply omitted from `projectRollups` rather than silently
    // treated as if it had produced a value.
    //
    // An Activity belongs to at most one Project (`projectId` is a single
    // optional FK, not a many-to-many relation) — so at most the OLD and
    // NEW project (when this same request also reassigns projectId) are
    // ever affected by one call, never more. Both are collected into a
    // single array so the response shape stays correct regardless of how
    // many projects end up affected.
    const statusChanged = data.status !== undefined && data.status !== existing.status;
    const rollups: Promise<ProjectRollupResult | null>[] = [];
    if (projectChanged && existing.projectId) {
      rollups.push(
        recalculateProjectRollup(existing.projectId).catch((err) => {
          console.error("[progress-rollup] old project recalculation failed:", err);
          return null;
        })
      );
    }
    if ((statusChanged || projectChanged) && activity.project?.id) {
      rollups.push(
        recalculateProjectRollup(activity.project.id).catch((err) => {
          console.error("[progress-rollup] activity change recalculation failed:", err);
          return null;
        })
      );
    }
    const settledRollups = rollups.length > 0 ? await Promise.all(rollups) : [];
    const projectRollups: ProjectRollupResult[] = settledRollups.filter((r): r is ProjectRollupResult => r !== null);

    // Published only after the update AND every awaited rollup above has
    // actually committed — never before. One coalesced publish per request
    // regardless of how many list-relevant fields changed together.
    if (ACTIVITY_LIST_RELEVANT_FIELDS.some((field) => (data as Record<string, unknown>)[field] !== undefined)) {
      publishActivityListInvalidation();
    }
    // Cross-entity: `rollups` was only ever populated when this update
    // actually affected a project's aggregate — either its visible
    // _count.activities (a reassignment: old and/or new project) or its
    // progress rollup (a status/completion change on an activity that
    // belongs to a project). Reusing that SAME condition here means this
    // publish fires in exactly the cases that genuinely changed something
    // the Project list (specifically /my-projects, which renders progress)
    // depends on — never on an unrelated field edit.
    if (rollups.length > 0) {
      publishProjectListInvalidation();
    }

    const statusDisplay = await getActivityStatusDisplay(effectiveDepartmentId, effectiveStatus);
    const { estimatedCost, actualCost } = computeActivityFinancials(activity);
    return NextResponse.json({ ...activity, estimatedCost: estimatedCost.toString(), actualCost: actualCost.toString(), statusLabel: statusDisplay.label, statusColor: statusDisplay.color, projectRollups });
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

    const activity = await prisma.projectActivity.findUnique({
      where: { id },
      select: { id: true, departmentId: true, projectId: true },
    });
    if (!activity) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }

    // Department-scoped, same resolver as GET/PATCH above — activity.delete
    // is its own permission (DEPARTMENT_ADMIN has it granted independently
    // of activity.edit; see prisma/seed.ts), never inferred from
    // activity.edit and never requiring global Role.ADMIN. canActOnEntity's
    // own canViewAllDepartments(role) bypass keeps a real System Admin's
    // behavior exactly as it was.
    const canDelete = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, activity.departmentId, "activity.delete");
    if (!canDelete) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Safe cascade behaviour (no migration needed):
    //   Ticket.activityId           → nullable, DB SetNull default
    //   _ActivityAssignees join rows → DB CASCADE (implicit M2M)
    //
    // Sequence renormalization (request-origin Projects only) happens in
    // the SAME transaction as the delete — the remaining Activities must
    // never show a gap (e.g. 1, 3, 4 after #2 is removed); locking the
    // Project row first serializes this against a concurrent reorder/
    // create/another delete on the same Project.
    const deletedProjectWasRequestOrigin = activity.projectId ? await isRequestOriginProject(activity.projectId) : false;
    await prisma.$transaction(async (tx) => {
      await tx.projectActivity.delete({ where: { id } });
      if (activity.projectId && deletedProjectWasRequestOrigin) {
        await normalizeProjectSequenceLocked(tx, activity.projectId);
      }
    });

    // AWAITED — same rationale as the create/PATCH rollup calls above: the
    // realtime publish below (and the router.refresh() it triggers) must
    // never race ahead of the parent project's own progress recalculation.
    // Deleting an activity changes that project's activity count/average
    // immediately, previously left stale here until some unrelated rollup.
    if (activity.projectId) {
      await recalculateProjectRollup(activity.projectId).catch((err) => {
        console.error("[progress-rollup] activity delete recalculation failed:", err);
        return null;
      });
    }

    // Published only after the delete (and, if applicable, the project
    // rollup) has actually committed above. The deleted activity disappears
    // from every Activity list.
    publishActivityListInvalidation();
    // Cross-entity: deleting an activity that belonged to a project changes
    // that project's visible _count.activities (and, now recalculated,
    // progress) — refresh the Project list too.
    if (activity.projectId) {
      publishProjectListInvalidation();
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
