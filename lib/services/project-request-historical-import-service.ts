/**
 * Phase 3 — Historical Project Request Architecture: the ONE dedicated,
 * privileged, transactional entry point for importing an existing
 * external Project as a genuine request-origin Project, without
 * fabricating a requester identity, approval record, or timestamp that
 * the source data doesn't actually support.
 *
 * Deliberately NOT a variant of createProjectFromApprovedRequest
 * (lib/services/project-request-service.ts) — that function's whole
 * premise is "an ALREADY-SUBMITTED ProjectRequest reaching APPROVED
 * through the normal workflow, then getting its Project built as a
 * separate step." Historical Import has no such prior request to react
 * to: it creates the ProjectRequest AND its Project together, atomically,
 * in one call — so this is its own function, not a second code path
 * bolted onto the normal one. It still reuses every canonical validator
 * the normal flow uses (resolveSystemWideActiveUserIds,
 * resolveProjectAudienceOrganizationalIds) rather than re-implementing
 * any of them, and writes to the exact same Project/ProjectRequest models
 * — never a second/parallel Project entity.
 *
 * Reused verbatim from the canonical Project architecture: Project
 * Department (shared with the ProjectRequest's own target department —
 * same invariant createProjectFromApprovedRequest enforces, "Department is
 * ALWAYS the request's own"), Project Owners, Requester Department,
 * Responsible People, and all three Audience types. Deliberately NOT
 * included (out of scope for this phase — see this file's own STOP FOR
 * REVIEW): Members, Facilities Services metadata, Expected Start/Finish/
 * Expense Type/External (those are request-origin-ONLY fields with no
 * historical-import equivalent decided yet), sub-department, and a
 * separate Project businessUnitId (direct placement, distinct from
 * Business Unit Audience).
 *
 * ─── Historical status semantics (Phase 3.1) ───
 * Every Historical Import row is created at ProjectRequestStatus.IMPORTED
 * — its OWN distinct terminal status, DELIBERATELY NEVER APPROVED. Phase 3
 * originally used APPROVED (reasoning: "a historical import always has an
 * already-operational Project, same as an APPROVED request that completed
 * setup") — Phase 3.1 corrects this: APPROVED specifically means "went
 * through the standard multi-stage approval workflow," which a historical
 * import never did, even when it has real approver/approvedAt metadata
 * from the source data. Conflating the two would distort every "Approved"
 * count/badge/filter with imports that were never actually decided here.
 * source: HISTORICAL_IMPORT remains the discriminator for WHERE a row came
 * from; status: IMPORTED is the discriminator for its OWN lifecycle state
 * — together they keep "this was imported" and "this is what happened to
 * it" independently clear, never collapsed into one signal. A STANDARD
 * request NEVER transitions to IMPORTED — the only writer of this status
 * is this function, at creation time. See decideApproval/
 * decideIntermediateApproval/createProjectFromApprovedRequest's own
 * explicit `source !== "STANDARD"` guards (unchanged by this correction —
 * already independent of status), which make a Historical Import row
 * structurally ineligible for every normal-workflow write boundary.
 *
 * requesterId/requesterDepartmentId/submittedAt/approverId/approvedAt/
 * businessAssessment are all OPTIONAL inputs here — set only when the
 * source data actually supports them, left null otherwise. NEVER
 * defaulted to "now"/"the importing admin"/a placeholder value — approver/
 * approvedAt/businessAssessment may be genuinely known and preserved even
 * though status is IMPORTED, never APPROVED. The Project's OWN lifecycle
 * status (`projectStatus`) is a REQUIRED, independent input — explicitly
 * NOT derived from the request's own status, since an imported external
 * Project may already be COMPLETED, still IN_PROGRESS, or anything else,
 * and that fact has nothing to do with the request's own IMPORTED status.
 *
 * ─── Notifications/reminders ───
 * This function calls NONE of createInAppNotification/
 * dispatchCreatedNotification/notifyEligibleApproversOfSubmission/
 * notifyIntermediateApprovers/scheduleSetupReminderInTx — a Historical
 * Import NEVER generates a retroactive notification, email, or setup
 * reminder of any kind. Its Project is linked in the SAME transaction
 * that creates the ProjectRequest, so there is also never a window where
 * it would be "APPROVED with no Project yet" (the exact condition every
 * reminder/setup-queue surface keys off) for any such surface to react to.
 *
 * ─── Idempotency ───
 * externalSourceId is a REQUIRED, unique, stable identifier from the
 * external source system. A second call with the same id resolves to the
 * ALREADY-CREATED ProjectRequest/Project (alreadyExisted: true) rather
 * than creating a duplicate — safe to re-run an import batch after a
 * partial failure.
 */
import { prisma } from "@/lib/prisma";
import type { ProjectStatus } from "@prisma/client";
import { resolveProjectAudienceOrganizationalIds, resolveSystemWideActiveUserIds } from "@/lib/services/project-audience-service";

export interface CreateHistoricalProjectRequestInput {
  // ─── Request + Project shared fields ───
  title: string;
  description: string;
  importance: number; // 1(Low)/2(Medium)/3(High) — reused verbatim as Project.priority, never a second scale.

  // ─── Request-only fields ───
  teamConcerned: string;
  expectedBenefits: string;
  replacesExisting?: boolean;
  replacementDescription?: string | null;
  externalSourceId: string;

  // The ONE shared target department — becomes BOTH
  // ProjectRequest.departmentId and Project.departmentId, same invariant
  // createProjectFromApprovedRequest enforces ("Department is ALWAYS the
  // request's own").
  departmentId: string;

  // Historical, informational only — existence-checked, never required to
  // be currently active (a departed/historical person is still a real
  // fact, not a capability grant) and never fabricated when genuinely
  // unknown.
  requesterId?: string | null;
  requesterDepartmentId?: string | null;
  submittedAt?: Date | null;
  approverId?: string | null;
  approvedAt?: Date | null;
  businessAssessment?: string | null;

  // ─── Project-only fields ───
  // The Project's OWN current lifecycle state — independent of the
  // request's approval status (always APPROVED for a historical import —
  // see this file's own doc comment).
  projectStatus: ProjectStatus;
  // Optional overrides — default to the shared title/description above
  // when omitted, since most historical imports describe the same record
  // on both sides; a caller importing from source data where they
  // genuinely differ may still set these independently.
  projectTitle?: string;
  projectDescription?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;

  ownerIds: string[];
  audienceIds?: string[];
  audienceDepartmentIds?: string[];
  audienceBusinessUnitIds?: string[];
  responsiblePeopleIds?: string[];
}

export type CreateHistoricalProjectRequestError =
  | { code: "invalid_department" }
  | { code: "invalid_project_owner" }
  | { code: "invalid_audience" }
  | { code: "invalid_audience_department" }
  | { code: "invalid_audience_business_unit" }
  | { code: "invalid_responsible_people" }
  | { code: "invalid_requester" }
  | { code: "invalid_requester_department" }
  | { code: "invalid_approver" };

export type CreateHistoricalProjectRequestResult =
  | { ok: true; projectRequestId: string; projectId: string; alreadyExisted: boolean }
  | { ok: false; error: CreateHistoricalProjectRequestError };

export async function createHistoricalProjectRequest(
  input: CreateHistoricalProjectRequestInput
): Promise<CreateHistoricalProjectRequestResult> {
  // Idempotency — a prior import of this exact external record already
  // exists -> resolve to it, never create a duplicate. A ProjectRequest
  // row with this externalSourceId but NO linked Project would be a
  // data-integrity anomaly (the two are always created together, in the
  // same transaction, below) — deliberately not special-cased here; the
  // transaction's own externalSourceId unique constraint is the real
  // backstop against a genuine race, never silently reused.
  const existingByExternalId = await prisma.projectRequest.findUnique({
    where: { externalSourceId: input.externalSourceId },
    select: { id: true, project: { select: { id: true } } },
  });
  if (existingByExternalId?.project) {
    return { ok: true, projectRequestId: existingByExternalId.id, projectId: existingByExternalId.project.id, alreadyExisted: true };
  }

  const department = await prisma.department.findUnique({ where: { id: input.departmentId }, select: { id: true, isActive: true } });
  if (!department || !department.isActive) return { ok: false, error: { code: "invalid_department" } };

  // System-wide, NEVER Department-scoped — same resolver, same rule
  // createProjectFromApprovedRequest/POST /api/projects already use for
  // Owner(s)/Audience/Responsible People. At least one Owner is required;
  // ownerIds[0] becomes the canonical Project.ownerId, never auto-derived.
  const ownerIds = await resolveSystemWideActiveUserIds(input.ownerIds);
  if (!ownerIds || ownerIds.length === 0) return { ok: false, error: { code: "invalid_project_owner" } };

  const audienceIds = await resolveSystemWideActiveUserIds(input.audienceIds ?? []);
  if (audienceIds === null) return { ok: false, error: { code: "invalid_audience" } };

  const audienceOrgResolution = await resolveProjectAudienceOrganizationalIds(input.audienceDepartmentIds ?? [], input.audienceBusinessUnitIds ?? []);
  if (!audienceOrgResolution.ok) return { ok: false, error: { code: audienceOrgResolution.code } };

  const responsiblePeopleIds = await resolveSystemWideActiveUserIds(input.responsiblePeopleIds ?? []);
  if (responsiblePeopleIds === null) return { ok: false, error: { code: "invalid_responsible_people" } };

  // Requester/Requester Department/Approver — historical, informational
  // facts, never a capability grant. Existence-only (never isActive): a
  // departed/deactivated person is still a real historical fact.
  if (input.requesterId) {
    const u = await prisma.user.findUnique({ where: { id: input.requesterId }, select: { id: true } });
    if (!u) return { ok: false, error: { code: "invalid_requester" } };
  }
  if (input.requesterDepartmentId) {
    const d = await prisma.department.findUnique({ where: { id: input.requesterDepartmentId }, select: { id: true } });
    if (!d) return { ok: false, error: { code: "invalid_requester_department" } };
  }
  if (input.approverId) {
    const u = await prisma.user.findUnique({ where: { id: input.approverId }, select: { id: true } });
    if (!u) return { ok: false, error: { code: "invalid_approver" } };
  }

  const { projectRequestId, projectId } = await prisma.$transaction(async (tx) => {
    const projectRequest = await tx.projectRequest.create({
      data: {
        title: input.title,
        description: input.description,
        importance: input.importance,
        teamConcerned: input.teamConcerned,
        expectedBenefits: input.expectedBenefits,
        replacesExisting: input.replacesExisting ?? false,
        replacementDescription: input.replacesExisting ? input.replacementDescription ?? null : null,
        departmentId: department.id,
        requesterId: input.requesterId ?? null,
        requesterDepartmentId: input.requesterDepartmentId ?? null,
        submittedAt: input.submittedAt ?? null,
        source: "HISTORICAL_IMPORT",
        // Always IMPORTED (Phase 3.1) — see this file's own doc comment
        // ("Historical status semantics"). Never APPROVED/PENDING_*/
        // REJECTED — APPROVED specifically means "completed the standard
        // workflow," which this never did, even with real approver
        // metadata preserved below.
        status: "IMPORTED",
        approverId: input.approverId ?? null,
        approvedAt: input.approvedAt ?? null,
        businessAssessment: input.businessAssessment ?? null,
        externalSourceId: input.externalSourceId,
      },
      select: { id: true },
    });

    const project = await tx.project.create({
      data: {
        title: input.projectTitle ?? input.title,
        description: input.projectDescription !== undefined ? input.projectDescription : input.description,
        status: input.projectStatus,
        priority: input.importance,
        departmentId: department.id,
        startDate: input.startDate ?? undefined,
        endDate: input.endDate ?? undefined,
        projectRequestId: projectRequest.id,
        ownerId: ownerIds[0],
        // Mirrors the single canonical owner into the authoritative
        // multi-owner relation — same invariant every other creation path
        // keeps ("owners always contains ownerId").
        owners: { connect: ownerIds.map((id) => ({ id })) },
        audience: audienceIds.length ? { connect: audienceIds.map((id) => ({ id })) } : undefined,
        audienceDepartments: audienceOrgResolution.departmentIds.length ? { connect: audienceOrgResolution.departmentIds.map((id) => ({ id })) } : undefined,
        audienceBusinessUnits: audienceOrgResolution.businessUnitIds.length ? { connect: audienceOrgResolution.businessUnitIds.map((id) => ({ id })) } : undefined,
        responsiblePeople: responsiblePeopleIds.length ? { connect: responsiblePeopleIds.map((id) => ({ id })) } : undefined,
      },
      select: { id: true },
    });

    return { projectRequestId: projectRequest.id, projectId: project.id };
  });

  return { ok: true, projectRequestId, projectId, alreadyExisted: false };
}
