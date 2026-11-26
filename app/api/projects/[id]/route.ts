import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasDepartmentPermission } from "@/lib/permissions";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { hasProjectViewAccess } from "@/lib/services/project-access-service";
import { getMembership } from "@/lib/services/department-membership-service";
import { userHasAssignablePermissionForEntity } from "@/lib/services/assignment-eligibility-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { updateProjectSchema, updateProjectRequestOriginFieldsSchema, facilitiesProjectFieldsSchema } from "@/lib/validations";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";
import { publishActivityListInvalidation } from "@/lib/realtime/activity-list-invalidation";
import { computeProjectFinancials } from "@/lib/services/project-financials-service";
import { resolveProjectDuration } from "@/lib/project-duration";
import { isSameDateOnly } from "@/lib/date-only";
import { notifyOwnerOfProjectCompletion } from "@/lib/services/project-feedback-service";
import {
  getFacilitiesServicesDepartmentId,
  hasFacilitiesFieldsPresent,
  resolveFacilitiesWrite,
  facilitiesResolutionErrorMessage,
  type ResolvedFacilitiesWrite,
} from "@/lib/services/project-facilities-service";
import { getFacilitiesImportanceGroupCounts, computeFacilitiesScorePercent } from "@/lib/services/project-scoring-service";
import { resolveProjectAudienceOrganizationalIds, resolveSystemWideActiveUserIds } from "@/lib/services/project-audience-service";
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
  // The full Owner set — needed by the Edit page's Owner(s) picker for a
  // Request-origin Project.
  owners: { select: { id: true, name: true, email: true, image: true } },
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
  members: { select: { id: true, name: true, email: true, image: true } },
  // Audience — available on every Project (Phase 1.1), needed here so the
  // Edit page can pre-populate all three picker groups (see
  // components/projects/project-form.tsx's "audience" state and the
  // standalone edit page's mirror of it).
  audience: { select: { id: true, name: true, email: true, image: true } },
  audienceDepartments: { select: { id: true, name: true } },
  audienceBusinessUnits: { select: { id: true, name: true } },
  // Responsible People (Phase 2) — its own, separate relation (never
  // Audience), needed here for the same Edit-page pre-population reason.
  responsiblePeople: { select: { id: true, name: true, email: true, image: true } },
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
// €0/€0, since a manual Activity never has taskSubTypeCost set) — the UI only
// ever renders these inside its own projectRequest-gated section.
function withProjectFinancials<T extends { activities: { taskSubTypeCost: any; expectedDays: number | null; actualDays: number | null }[] }>(
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

    // Lets the client decide whether to show/edit the Facilities
    // Information section without re-deriving the Department identity
    // check itself (never display-name matching) — a UI hint only, the
    // real enforcement is in PATCH below. The raw facilitiesCompany/
    // Location/precision/quarter/year fields are still returned even when
    // this is false (e.g. a Project that USED to be Facilities Services —
    // see PATCH's own doc comment on why that history is never cleared);
    // the client is what hides them outside the workspace.
    const facilitiesServicesDepartmentId = await getFacilitiesServicesDepartmentId();
    const isFacilitiesServicesWorkspace = !!facilitiesServicesDepartmentId && project.departmentId === facilitiesServicesDepartmentId;

    // Computed fresh on every GET, never stored — see
    // lib/services/project-scoring-service.ts's own doc comment. Only
    // queried when actually needed (a non-Facilities Project has nothing
    // to compute).
    const facilitiesScorePercent = isFacilitiesServicesWorkspace
      ? computeFacilitiesScorePercent(project.facilitiesProjectImportanceOverall, project.facilitiesProjectScore, await getFacilitiesImportanceGroupCounts())
      : null;

    return NextResponse.json({ ...withProjectFinancials(project), isFacilitiesServicesWorkspace, facilitiesScorePercent });
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
      select: {
        departmentId: true,
        status: true,
        title: true,
        ownerId: true,
        expectedStartDate: true,
        expectedFinishDate: true,
        expectedTotalInitialDays: true,
        expectedTotalInitialDaysOverridden: true,
        actualTotalDays: true,
        actualTotalDaysOverridden: true,
        expenseTypeId: true,
        projectRequestId: true,
        startDate: true,
        endDate: true,
        facilitiesStartPrecision: true,
        facilitiesStartQuarter: true,
        facilitiesStartYear: true,
        facilitiesEndPrecision: true,
        facilitiesEndQuarter: true,
        facilitiesEndYear: true,
      },
    });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const canEdit = await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, existing.departmentId, "project.edit");
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    // Merged with the request-origin-only editable fields (Expected
    // Start/Finish, Expected Total Initial Days override, Expense Type,
    // External) — expectedTotalInitialDays itself is never accepted raw;
    // it is resolved below via lib/project-duration.ts. Accepted for ANY Project being
    // edited, not just ones with projectRequestId set — the UI only ever
    // OFFERS this block for request-origin Projects (see
    // app/(main)/projects/[id]/edit/page.tsx), but there's no extra
    // security boundary being bypassed by also allowing it here: editing
    // these fields still requires the SAME project.edit this route already
    // re-checks above, on a real, already-existing Project. Facilities
    // Services fields are merged in the SAME way, but DO have an extra
    // boundary — see the isFacilitiesWorkspace check below, right after
    // effectiveDepartmentId is resolved.
    const data = updateProjectSchema.merge(updateProjectRequestOriginFieldsSchema).merge(facilitiesProjectFieldsSchema).parse(body);

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

    const {
      memberIds,
      startDate,
      endDate,
      expectedStartDate,
      expectedFinishDate,
      expectedTotalInitialDaysOverride,
      actualTotalDaysOverride,
      ownerIds,
      facilitiesCompany,
      facilitiesLocation,
      facilitiesStartPrecision,
      facilitiesStartQuarter,
      facilitiesStartYear,
      facilitiesEndPrecision,
      facilitiesEndQuarter,
      facilitiesEndYear,
      facilitiesCategory,
      facilitiesEstimatedCost,
      facilitiesEstimatedCostNotes,
      facilitiesActualCost,
      facilitiesActualCostNotes,
      facilitiesPlannedForAnnualTargets,
      facilitiesIsBigProject,
      facilitiesProjectImportanceOverall,
      facilitiesProjectScore,
      audienceIds,
      audienceDepartmentIds,
      audienceBusinessUnitIds,
      responsiblePeopleIds,
      ...rest
    } = data;
    const effectiveDepartmentId = data.departmentId !== undefined ? data.departmentId : existing.departmentId;

    // Organizational Audience — available on every Project. `undefined`
    // (key omitted) leaves that set untouched; an explicit array (even
    // empty) REPLACES the full set — same "omitted vs. explicit" PATCH
    // convention as every other optional field on this route. Department
    // and Business Unit audience are independently omittable — resolving
    // BOTH together only when both are actually present would otherwise
    // wrongly treat an omitted one as "clear it".
    // Business Unit Audience is not available for Projects created from a
    // Project Request (persisted origin: projectRequestId), matching
    // createProjectFromRequestSchema at creation time. A PATCH may keep or
    // remove existing (historical) Business Unit associations but may never
    // ADD one — and since the edit page doesn't send this field for such a
    // Project, historical associations are never removed automatically.
    if (existing.projectRequestId && audienceBusinessUnitIds !== undefined) {
      const current = await prisma.project.findUnique({ where: { id }, select: { audienceBusinessUnits: { select: { id: true } } } });
      const currentIds = new Set((current?.audienceBusinessUnits ?? []).map((b) => b.id));
      if (audienceBusinessUnitIds.some((buId) => !currentIds.has(buId))) {
        return NextResponse.json(
          { error: "Business Units cannot be added to the Audience of a Project created from a Project Request.", code: "audience_business_units_not_allowed" },
          { status: 422 }
        );
      }
    }

    let resolvedAudienceDepartmentIds: string[] | undefined;
    let resolvedAudienceBusinessUnitIds: string[] | undefined;
    if (audienceDepartmentIds !== undefined || audienceBusinessUnitIds !== undefined) {
      const resolution = await resolveProjectAudienceOrganizationalIds(audienceDepartmentIds ?? [], audienceBusinessUnitIds ?? []);
      if (!resolution.ok) {
        const message =
          resolution.code === "invalid_audience_department"
            ? "One or more selected Audience Departments do not exist or are not active."
            : "One or more selected Audience Business Units do not exist.";
        return NextResponse.json({ error: message, code: resolution.code }, { status: 400 });
      }
      if (audienceDepartmentIds !== undefined) resolvedAudienceDepartmentIds = resolution.departmentIds;
      if (audienceBusinessUnitIds !== undefined) resolvedAudienceBusinessUnitIds = resolution.businessUnitIds;
    }

    // Owner(s) — Request-origin Projects only, same eligibility as Project
    // setup (resolveSystemWideActiveUserIds: real, active users,
    // system-wide; at least one). Authorization is this route's existing
    // project.edit gate above. The primary owner (ownerId) is kept when
    // still selected, otherwise the first selected owner becomes primary.
    // Ownership-derived access (hasProjectViewAccess, "My Projects") is
    // computed live from these relations, so it follows the change. The
    // Project Request (requester, approvals) and related Activities/Tickets
    // are never touched. A standalone Project ignores ownerIds (unchanged).
    let ownerWrite: { ownerId: string; owners: { set: { id: string }[] } } | undefined;
    if (existing.projectRequestId && ownerIds !== undefined) {
      const resolvedOwners = await resolveSystemWideActiveUserIds(ownerIds);
      if (!resolvedOwners || resolvedOwners.length === 0) {
        return NextResponse.json({ error: "Select at least one Owner — every Owner must be a real, active user.", code: "invalid_project_owner" }, { status: 400 });
      }
      const primary = resolvedOwners.includes(existing.ownerId) ? existing.ownerId : resolvedOwners[0];
      ownerWrite = { ownerId: primary, owners: { set: resolvedOwners.map((oid) => ({ id: oid })) } };
    }

    // Individual Audience — available on every Project as of Phase 1.1,
    // same independent omit-vs-replace semantics as the Organizational
    // Audience fields above (omitted leaves it untouched; an explicit
    // array, even empty, replaces the full set).
    let resolvedAudienceUserIds: string[] | undefined;
    if (audienceIds !== undefined) {
      const resolved = await resolveSystemWideActiveUserIds(audienceIds);
      if (resolved === null) {
        return NextResponse.json({ error: "One or more selected Audience users are not real, active users.", code: "invalid_audience" }, { status: 400 });
      }
      resolvedAudienceUserIds = resolved;
    }

    // Responsible People (Phase 2) — same independent omit-vs-replace
    // semantics, same system-wide validation, own separate relation.
    let resolvedResponsiblePeopleIds: string[] | undefined;
    if (responsiblePeopleIds !== undefined) {
      const resolved = await resolveSystemWideActiveUserIds(responsiblePeopleIds);
      if (resolved === null) {
        return NextResponse.json({ error: "One or more selected Responsible People are not real, active users.", code: "invalid_responsible_people" }, { status: 400 });
      }
      resolvedResponsiblePeopleIds = resolved;
    }

    // Facilities Services-only metadata — rejected outright (requirement:
    // "prevent unauthorized changes") for a Project whose EFFECTIVE
    // department (after this same request's own possible departmentId
    // change) isn't Facilities Services. This is also what keeps a
    // Project's HISTORICAL Facilities metadata safe once it's been moved
    // out: nothing in this route ever clears those columns on a
    // department change away (see the data object built below — the
    // facilities keys are simply never touched when !isFacilitiesWorkspace,
    // left exactly as they were), and this same check stops anyone from
    // writing new values into them from that point on. Checked against the
    // RAW body, same reasoning as POST /api/projects.
    const facilitiesServicesDepartmentId = await getFacilitiesServicesDepartmentId();
    const isFacilitiesWorkspace = !!facilitiesServicesDepartmentId && effectiveDepartmentId === facilitiesServicesDepartmentId;
    if (!isFacilitiesWorkspace && hasFacilitiesFieldsPresent(body)) {
      return NextResponse.json(
        { error: "Facilities-specific fields can only be set for a Project in the Facilities Services workspace.", code: "facilities_fields_not_allowed" },
        { status: 400 }
      );
    }
    // Only recomputed when THIS request actually touches a date or a
    // facilities-only field — editing, say, just the title must never
    // silently re-persist (and re-derive) an unrelated Start/End.
    const facilitiesRelevantFieldsTouched =
      startDate !== undefined ||
      endDate !== undefined ||
      facilitiesStartPrecision !== undefined ||
      facilitiesStartQuarter !== undefined ||
      facilitiesStartYear !== undefined ||
      facilitiesEndPrecision !== undefined ||
      facilitiesEndQuarter !== undefined ||
      facilitiesEndYear !== undefined;
    let facilitiesWrite: ResolvedFacilitiesWrite | null = null;
    if (isFacilitiesWorkspace && facilitiesRelevantFieldsTouched) {
      const effectiveStartPrecision = facilitiesStartPrecision !== undefined ? facilitiesStartPrecision : existing.facilitiesStartPrecision;
      const effectiveEndPrecision = facilitiesEndPrecision !== undefined ? facilitiesEndPrecision : existing.facilitiesEndPrecision;
      const startSwitchedAwayFromQuarter = existing.facilitiesStartPrecision === "QUARTER" && effectiveStartPrecision !== "QUARTER" && startDate === undefined;
      const endSwitchedAwayFromQuarter = existing.facilitiesEndPrecision === "QUARTER" && effectiveEndPrecision !== "QUARTER" && endDate === undefined;
      const resolution = resolveFacilitiesWrite({
        startPrecision: effectiveStartPrecision,
        startQuarter: facilitiesStartQuarter !== undefined ? facilitiesStartQuarter : existing.facilitiesStartQuarter,
        startYear: facilitiesStartYear !== undefined ? facilitiesStartYear : existing.facilitiesStartYear,
        // Never fall back to the EXISTING startDate when this request is
        // switching Start away from QUARTER — that existing value IS the
        // old quarter-derived boundary, and falling back to it here would
        // silently re-persist it as if it had just been typed in as an
        // exact date (exactly what switchedAwayFromQuarter below exists
        // to reject instead).
        startExact: startDate !== undefined ? startDate : startSwitchedAwayFromQuarter ? null : existing.startDate ? existing.startDate.toISOString() : null,
        endPrecision: effectiveEndPrecision,
        endQuarter: facilitiesEndQuarter !== undefined ? facilitiesEndQuarter : existing.facilitiesEndQuarter,
        endYear: facilitiesEndYear !== undefined ? facilitiesEndYear : existing.facilitiesEndYear,
        endExact: endDate !== undefined ? endDate : endSwitchedAwayFromQuarter ? null : existing.endDate ? existing.endDate.toISOString() : null,
        switchedAwayFromQuarter: { start: startSwitchedAwayFromQuarter, end: endSwitchedAwayFromQuarter },
      });
      if (!resolution.ok) {
        return NextResponse.json({ error: facilitiesResolutionErrorMessage(resolution.error), code: resolution.error.code }, { status: 400 });
      }
      facilitiesWrite = resolution.value;
    }

    // Category/Estimated-Actual Cost/Notes: plain direct inputs, no
    // resolver/derivation involved (unlike Start/End) — computed once and
    // applied the same way regardless of whether this request also touched
    // a date field. `undefined` (key omitted) leaves the column untouched;
    // `null` explicitly clears it. Never touched at all when
    // !isFacilitiesWorkspace, which is what preserves a Project's
    // historical Facilities cost data once it's moved to another
    // department (same reasoning as facilitiesCompany/facilitiesLocation).
    const facilitiesDirectFields = isFacilitiesWorkspace
      ? {
          facilitiesCategory: facilitiesCategory !== undefined ? facilitiesCategory : undefined,
          facilitiesEstimatedCost: facilitiesEstimatedCost !== undefined ? facilitiesEstimatedCost : undefined,
          facilitiesEstimatedCostNotes: facilitiesEstimatedCostNotes !== undefined ? facilitiesEstimatedCostNotes : undefined,
          facilitiesActualCost: facilitiesActualCost !== undefined ? facilitiesActualCost : undefined,
          facilitiesActualCostNotes: facilitiesActualCostNotes !== undefined ? facilitiesActualCostNotes : undefined,
          // Plain booleans — `undefined` (key omitted) leaves the column
          // untouched; an explicit `false` is a real, intentional write
          // (there is no tri-state "clear" for a non-nullable Boolean
          // column), same "!== undefined" convention as every field above.
          facilitiesPlannedForAnnualTargets: facilitiesPlannedForAnnualTargets !== undefined ? facilitiesPlannedForAnnualTargets : undefined,
          facilitiesIsBigProject: facilitiesIsBigProject !== undefined ? facilitiesIsBigProject : undefined,
          // Project Scoring's two persisted inputs — same convention as
          // every field above: `undefined` leaves the column untouched,
          // `null` explicitly clears it. Importance Score/Score are
          // derived, never written here.
          facilitiesProjectImportanceOverall: facilitiesProjectImportanceOverall !== undefined ? facilitiesProjectImportanceOverall : undefined,
          facilitiesProjectScore: facilitiesProjectScore !== undefined ? facilitiesProjectScore : undefined,
        }
      : {};

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

    // Plain (non-Facilities-resolved) Start/End write: undefined (key
    // omitted) leaves the column untouched; null/"" (explicitly cleared)
    // persists NULL; a real value persists the parsed Date.
    const plainStartDateWrite = startDate === undefined ? undefined : startDate ? new Date(startDate) : null;
    const plainEndDateWrite = endDate === undefined ? undefined : endDate ? new Date(endDate) : null;

    // Durations — the ONE canonical resolver (lib/project-duration.ts),
    // in working days. Any other (unrelated) update leaves both the value
    // and its manual/automatic mode exactly as stored. In automatic mode a
    // date change recalculates; a manual override is kept until an explicit
    // reset (override = null). Durations never modify dates. The effective
    // dates are exactly the values persisted by this same update.
    const effectiveActualStart = facilitiesWrite ? facilitiesWrite.startDate : plainStartDateWrite !== undefined ? plainStartDateWrite : existing.startDate;
    const effectiveActualEnd = facilitiesWrite ? facilitiesWrite.endDate : plainEndDateWrite !== undefined ? plainEndDateWrite : existing.endDate;
    // Re-resolved only when this duration's dates ACTUALLY CHANGE (not merely
    // re-sent by the full-snapshot edit form), or when its mode is
    // explicitly switched: a numeric override, or a reset (null) of a
    // currently MANUAL value. A null for an already-automatic duration with
    // unchanged dates is a no-op — so an unrelated save never silently
    // rewrites a stored value (e.g. a historical calendar-day value from
    // before the working-day rule).
    const actualDatesChanged = !isSameDateOnly(effectiveActualStart, existing.startDate) || !isSameDateOnly(effectiveActualEnd, existing.endDate);
    const actualDurationTouched =
      actualDatesChanged || typeof actualTotalDaysOverride === "number" || (actualTotalDaysOverride === null && existing.actualTotalDaysOverridden);
    const actualDuration = actualDurationTouched
      ? resolveProjectDuration({
          start: effectiveActualStart,
          finish: effectiveActualEnd,
          override: actualTotalDaysOverride,
          current: { value: existing.actualTotalDays, overridden: existing.actualTotalDaysOverridden },
        })
      : null;
    const expectedDatesChanged =
      !isSameDateOnly(effectiveExpectedStart, existing.expectedStartDate) || !isSameDateOnly(effectiveExpectedFinish, existing.expectedFinishDate);
    const expectedDurationTouched =
      expectedDatesChanged ||
      typeof expectedTotalInitialDaysOverride === "number" ||
      (expectedTotalInitialDaysOverride === null && existing.expectedTotalInitialDaysOverridden);
    const expectedDuration = expectedDurationTouched
      ? resolveProjectDuration({
          start: effectiveExpectedStart,
          finish: effectiveExpectedFinish,
          override: expectedTotalInitialDaysOverride,
          current: { value: existing.expectedTotalInitialDays, overridden: existing.expectedTotalInitialDaysOverridden },
        })
      : null;

    // Department changed but no explicit new sub-department was given — the
    // stale one (if any) can no longer be valid, so it's cleared.
    const departmentChanging = data.departmentId !== undefined && data.departmentId !== existing.departmentId;
    const clearStaleSubDepartment = departmentChanging && rest.subDepartmentId === undefined;

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...rest,
        subDepartmentId: clearStaleSubDepartment ? null : rest.subDepartmentId,
        // Facilities Services, and this request actually touched a
        // relevant field: the resolved write wins (already derived
        // startDate/endDate from whichever of Quarter/Exact applies).
        // Everything else (including a Facilities Project whose date
        // fields this particular request doesn't touch at all): the
        // exact, unmodified pre-existing behavior — `rest` never includes
        // the 8 facilities keys (destructured out above), so they're
        // simply left untouched here, which is also what preserves a
        // Project's HISTORICAL Facilities metadata once it's moved to a
        // different department (nothing in this branch ever clears it).
        ...(facilitiesWrite
          ? {
              ...facilitiesWrite,
              facilitiesCompany: facilitiesCompany !== undefined ? facilitiesCompany : undefined,
              facilitiesLocation: facilitiesLocation !== undefined ? facilitiesLocation : undefined,
              ...facilitiesDirectFields,
            }
          : {
              startDate: plainStartDateWrite,
              endDate: plainEndDateWrite,
              ...(isFacilitiesWorkspace
                ? { facilitiesCompany: facilitiesCompany !== undefined ? facilitiesCompany : undefined, facilitiesLocation: facilitiesLocation !== undefined ? facilitiesLocation : undefined }
                : {}),
              ...facilitiesDirectFields,
            }),
        // undefined (key omitted) -> leave untouched; null/"" (explicitly
        // cleared) -> persist NULL; a real value -> the parsed Date. Reuses
        // the exact same effective values already computed above for the
        // finish>=start check, so the two can never disagree.
        expectedStartDate: expectedStartDate === undefined ? undefined : effectiveExpectedStart,
        expectedFinishDate: expectedFinishDate === undefined ? undefined : effectiveExpectedFinish,
        ...(expectedDuration ? { expectedTotalInitialDays: expectedDuration.value, expectedTotalInitialDaysOverridden: expectedDuration.overridden } : {}),
        ...(actualDuration ? { actualTotalDays: actualDuration.value, actualTotalDaysOverridden: actualDuration.overridden } : {}),
        members: memberIds
          ? { set: memberIds.map((memberId) => ({ id: memberId })) }
          : undefined,
        audience: resolvedAudienceUserIds !== undefined ? { set: resolvedAudienceUserIds.map((id) => ({ id })) } : undefined,
        audienceDepartments: resolvedAudienceDepartmentIds !== undefined ? { set: resolvedAudienceDepartmentIds.map((id) => ({ id })) } : undefined,
        audienceBusinessUnits: resolvedAudienceBusinessUnitIds !== undefined ? { set: resolvedAudienceBusinessUnitIds.map((id) => ({ id })) } : undefined,
        responsiblePeople: resolvedResponsiblePeopleIds !== undefined ? { set: resolvedResponsiblePeopleIds.map((id) => ({ id })) } : undefined,
        ...(ownerWrite ?? {}),
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

    // Notify + email the Project's primary Owner the moment THIS save is
    // what just completed a request-origin Project — never on an
    // unrelated edit of an already-COMPLETED Project, never for a manual
    // one (no projectRequestId). This is the ONE canonical genuine
    // non-COMPLETED -> COMPLETED transition check (never re-derived
    // elsewhere) — a reopen + later re-complete cycle legitimately fires
    // this again, a repeated PATCH while already COMPLETED never does.
    // notifyOwnerOfProjectCompletion never throws (both the in-app
    // notification and the email send are independently caught/logged
    // inside it), so this can never turn an otherwise-successful PATCH
    // into an error response or roll back the completion itself.
    if (existing.status !== "COMPLETED" && project.status === "COMPLETED" && existing.projectRequestId) {
      await notifyOwnerOfProjectCompletion({ id: project.id, title: project.title, projectRequestId: existing.projectRequestId, owner: project.owner });
    }

    // Recomputed from the just-committed row, same as GET — a Save always
    // reflects the result of what was just saved, never a stale value
    // from before this request (see the "Edit" UX: the displayed Score
    // refreshes after Save).
    const facilitiesScorePercent = isFacilitiesWorkspace
      ? computeFacilitiesScorePercent(project.facilitiesProjectImportanceOverall, project.facilitiesProjectScore, await getFacilitiesImportanceGroupCounts())
      : null;

    return NextResponse.json({ ...withProjectFinancials(project), isFacilitiesServicesWorkspace: isFacilitiesWorkspace, facilitiesScorePercent });
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
