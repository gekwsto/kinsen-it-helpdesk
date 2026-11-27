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
 *
 * ─── Final Import Safety Corrections — canonical payload fingerprint ───
 * The ORIGINAL Phase 4.1 conflict check compared only title/departmentId —
 * too narrow (a payload differing in, say, Owners or Audiences but
 * sharing the same title/department would have been silently accepted as
 * "the same import"). Replaced by computeImportPayloadFingerprint: a
 * sha256 hash of the COMPLETE normalized payload — every persisted field
 * and relationship (Owners, Requester Department, Audiences, Responsible
 * People, Project status, every date, historicalSourceMetadata) —
 * computed BEFORE any DB resolution, directly from the caller's own input
 * ids (never from names, never DB-dependent), and persisted ONCE, at
 * creation, into the IMMUTABLE ProjectRequest.historicalImportFingerprint
 * column (see its own doc comment). A second call with the same
 * externalSourceId:
 *   - SAME normalized payload (same fingerprint) -> idempotent success
 *     (alreadyExisted: true), even if the LIVE Project/Request have since
 *     been edited through the normal UI — the comparison is always
 *     against the ORIGINAL stored fingerprint, never the current row.
 *   - DIFFERENT normalized payload (different fingerprint) -> rejected as
 *     external_source_id_conflict, never silently resolved to the
 *     existing, now-mismatched row.
 * Unordered relationship id collections (ownerIds/audienceIds/
 * audienceDepartmentIds/audienceBusinessUnitIds/responsiblePeopleIds) are
 * sorted before hashing, so the SAME set in a different order still
 * fingerprints identically. This never "overwrites" either way (no write
 * ever happens on the idempotent OR the conflict path); the check exists
 * purely to surface a mismatched-identity bug loudly instead of masking it
 * behind a deceptively successful 200.
 *
 * ─── Phase 4.1 — mandatory-field relaxation for Historical Imports ───
 * description/importance/teamConcerned/expectedBenefits are all OPTIONAL
 * here (nullable on ProjectRequest as of this phase) because the real
 * source data for the first production import batch has no column at all
 * for importance/teamConcerned/expectedBenefits, and is missing
 * description for at least one row — see the schema's own doc comments.
 * STANDARD submissions are COMPLETELY UNAFFECTED: createProjectRequestSchema
 * (lib/validations.ts) still requires all four, so this relaxation is
 * reachable ONLY through this function. When importance is absent, the
 * linked Project's OWN `priority` is left unset here so its column default
 * (2/Medium) applies — the same default every OTHER Project creation path
 * already falls back to when no priority is chosen; this is a live-field
 * default for an ongoing Project property, never a fabricated HISTORICAL
 * fact recorded on the request itself (which stays genuinely null).
 *
 * ─── Phase 4.1 — Expected Start/Finish ───
 * expectedStartDate/expectedFinishDate extend the historical contract to
 * the SAME canonical Project fields createProjectFromApprovedRequest
 * populates for a standard request-origin Project (Project.
 * expectedStartDate/expectedFinishDate/expectedTotalInitialDays) — reused
 * verbatim, not a parallel pair of historical-only columns. Deliberately
 * independent of startDate/endDate above (those keep their own pre-
 * existing "actual" Gantt/filter semantics; see Project's own doc
 * comment). expectedTotalInitialDays is computed the SAME way
 * createProjectFromApprovedRequest computes it (working days, lib/date-only.ts)
 * — but ONLY when BOTH expected dates are actually known; a historical row
 * missing either one simply leaves it null, never estimated from Total
 * Days or any other proxy (see this file's own note on Total Days below).
 *
 * ─── Phase 4.1 — historicalSourceMetadata ───
 * A structured, OPTIONAL bag for source fields with no canonical
 * destination anywhere else (see ProjectRequest.historicalSourceMetadata's
 * own doc comment for the restriction to Historical Imports). The ONE
 * deliberately-omitted source field here is "Total Days": its relationship
 * to Expected/Actual Start/Finish could not be verified against the real
 * source data (neither difference matches it consistently across sample
 * rows), so it is preserved here, verbatim, as originalTotalDays — NEVER
 * assigned to expectedTotalInitialDays or any Activity duration field
 * without that evidence. Ticket ID and Zoho Link are NEVER accepted here —
 * both are explicitly out of scope for import (see this feature's own
 * "Explicit exclusions") and this function has no field for either.
 */
import { prisma } from "@/lib/prisma";
import { resolveProjectStatusWrite } from "@/lib/services/project-status-service";
import { Prisma, type ProjectStatus } from "@prisma/client";
import { resolveProjectAudienceOrganizationalIds, resolveSystemWideActiveUserIds } from "@/lib/services/project-audience-service";
import { resolveProjectDuration } from "@/lib/project-duration";
import crypto from "crypto";

// Phase 4.1 — see this file's own "historicalSourceMetadata" doc comment.
// A closed shape (never an open index signature) so every key this app
// ever writes here is deliberate and documented — "other meaningful
// unmapped information" from a future source file extends this type
// explicitly, rather than accepting arbitrary caller-supplied keys.
// Each field is independently nullable (distinct from omitted) so a real
// zero is never confused with "not recorded" — see the schema's own note.
export interface HistoricalSourceMetadata {
  feedbackUsers?: string | null;
  originalEstimatedCost?: number | null;
  originalActualCost?: number | null;
  // Preserved verbatim ONLY when no verified canonical mapping exists for
  // it (see this file's own top-level doc comment) — never written
  // alongside a derived expectedTotalInitialDays as if the two agreed.
  originalTotalDays?: number | null;
}

export interface CreateHistoricalProjectRequestInput {
  // ─── Request + Project shared fields ───
  title: string;
  // Phase 4.1 — optional/nullable; see this file's own doc comment on
  // mandatory-field relaxation. Never fabricated when the source data
  // genuinely has none.
  description?: string | null;
  importance?: number | null; // 1(Low)/2(Medium)/3(High) — reused verbatim as Project.priority, never a second scale.

  // ─── Request-only fields ───
  // Phase 4.1 — both optional/nullable; see this file's own doc comment.
  teamConcerned?: string | null;
  expectedBenefits?: string | null;
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
  // Phase 4.1 — see this file's own "Expected Start/Finish" doc comment.
  expectedStartDate?: Date | null;
  expectedFinishDate?: Date | null;

  // Phase 4.1 — see this file's own "historicalSourceMetadata" doc comment.
  historicalSourceMetadata?: HistoricalSourceMetadata | null;

  ownerIds: string[];
  audienceIds?: string[];
  audienceDepartmentIds?: string[];
  audienceBusinessUnitIds?: string[];
  responsiblePeopleIds?: string[];
}

function normalizeDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function normalizeIdSet(ids: string[] | undefined): string[] {
  // Sorted so the SAME unordered set fingerprints identically regardless
  // of the order the caller happened to list it in.
  return [...(ids ?? [])].sort();
}

function normalizeMetadata(m: HistoricalSourceMetadata | null | undefined) {
  return {
    feedbackUsers: m?.feedbackUsers ?? null,
    originalEstimatedCost: m?.originalEstimatedCost ?? null,
    originalActualCost: m?.originalActualCost ?? null,
    originalTotalDays: m?.originalTotalDays ?? null,
  };
}

/**
 * Final Import Safety Corrections — see this file's own top-level doc
 * comment ("canonical payload fingerprint"). A PURE function of the input
 * as given — never touches the database, never resolves a name to an id
 * — so it can run both BEFORE validation (to short-circuit an idempotent/
 * conflicting retry early) and, identically, at creation time to persist
 * the value that later retries are compared against. Deliberately
 * excludes externalSourceId itself (the lookup key, not part of "the rest
 * of the payload") and replacesExisting/replacementDescription's own
 * conditional relationship is preserved exactly as the create call itself
 * applies it, so a replacementDescription value that would be silently
 * discarded at creation (replacesExisting: false) never affects the
 * fingerprint either.
 */
export function computeImportPayloadFingerprint(input: CreateHistoricalProjectRequestInput): string {
  const canonical = {
    title: input.title,
    description: input.description ?? null,
    importance: input.importance ?? null,
    teamConcerned: input.teamConcerned ?? null,
    expectedBenefits: input.expectedBenefits ?? null,
    replacesExisting: input.replacesExisting ?? false,
    replacementDescription: input.replacesExisting ? input.replacementDescription ?? null : null,
    departmentId: input.departmentId,
    requesterId: input.requesterId ?? null,
    requesterDepartmentId: input.requesterDepartmentId ?? null,
    submittedAt: normalizeDate(input.submittedAt),
    approverId: input.approverId ?? null,
    approvedAt: normalizeDate(input.approvedAt),
    businessAssessment: input.businessAssessment ?? null,
    projectStatus: input.projectStatus,
    projectTitle: input.projectTitle ?? null,
    projectDescription: input.projectDescription !== undefined ? input.projectDescription : null,
    startDate: normalizeDate(input.startDate),
    endDate: normalizeDate(input.endDate),
    expectedStartDate: normalizeDate(input.expectedStartDate),
    expectedFinishDate: normalizeDate(input.expectedFinishDate),
    historicalSourceMetadata: normalizeMetadata(input.historicalSourceMetadata),
    ownerIds: normalizeIdSet(input.ownerIds),
    audienceIds: normalizeIdSet(input.audienceIds),
    audienceDepartmentIds: normalizeIdSet(input.audienceDepartmentIds),
    audienceBusinessUnitIds: normalizeIdSet(input.audienceBusinessUnitIds),
    responsiblePeopleIds: normalizeIdSet(input.responsiblePeopleIds),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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
  | { code: "invalid_approver" }
  // Phase 4.1 — see this file's own "Idempotency" doc comment.
  | { code: "external_source_id_conflict" };

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
  //
  // Computed BEFORE any DB resolution (see computeImportPayloadFingerprint's
  // own doc comment) so the idempotent/conflict decision never depends on
  // whether department/owner/etc. names happen to resolve.
  const fingerprint = computeImportPayloadFingerprint(input);
  const existingByExternalId = await prisma.projectRequest.findUnique({
    where: { externalSourceId: input.externalSourceId },
    select: { id: true, historicalImportFingerprint: true, project: { select: { id: true } } },
  });
  if (existingByExternalId?.project) {
    // Final Import Safety Corrections — compared against the STORED,
    // immutable fingerprint from the ORIGINAL creation, never against the
    // live Project/Request's current (possibly since-edited) state — see
    // this file's own top-level doc comment.
    if (existingByExternalId.historicalImportFingerprint !== fingerprint) {
      return { ok: false, error: { code: "external_source_id_conflict" } };
    }
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

  // Phase 4.1 — see this file's own "Expected Start/Finish" doc comment:
  // computed ONLY when both dates are actually known, exactly like
  // createProjectFromApprovedRequest's own calculation; never estimated
  // from Total Days or any other proxy.
  // Both via the ONE canonical resolver (lib/project-duration.ts) —
  // automatic mode, null whenever either date is unknown.
  const expectedTotalInitialDays = resolveProjectDuration({ start: input.expectedStartDate, finish: input.expectedFinishDate, override: undefined }).value ?? undefined;
  const actualTotalDays = resolveProjectDuration({ start: input.startDate, finish: input.endDate, override: undefined }).value ?? undefined;

  const { projectRequestId, projectId } = await prisma.$transaction(async (tx) => {
    const projectRequest = await tx.projectRequest.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        importance: input.importance ?? null,
        teamConcerned: input.teamConcerned ?? null,
        expectedBenefits: input.expectedBenefits ?? null,
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
        historicalSourceMetadata: (input.historicalSourceMetadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        // Written ONCE, here, and never again — see this column's own doc
        // comment and computeImportPayloadFingerprint's.
        historicalImportFingerprint: fingerprint,
      },
      select: { id: true },
    });

    // Historical canonical status -> its configured Project Status (shared
    // resolver: the active system definition of that state, else the first
    // active one). If NONE is active, the import EXPLICITLY links that
    // state's SYSTEM definition (a deliberate, documented exception: an
    // import records a historical fact, not a new user selection) — never
    // left to the DB trigger, which rejects canonical-only writes when no
    // active definition exists.
    const statusResolution = await resolveProjectStatusWrite({ status: input.projectStatus }, null, tx);
    const importStatusDefinitionId =
      statusResolution.ok && statusResolution.write
        ? statusResolution.write.statusDefinitionId
        : (await tx.projectStatusDefinition.findFirstOrThrow({ where: { isSystem: true, canonicalStatus: input.projectStatus }, select: { id: true } })).id;
    const project = await tx.project.create({
      data: {
        title: input.projectTitle ?? input.title,
        description: input.projectDescription !== undefined ? input.projectDescription : input.description ?? null,
        status: input.projectStatus,
        statusDefinitionId: importStatusDefinitionId,
        // Omitted (not `null`) when unknown, so Project's OWN column
        // default (2/Medium) applies — see this file's own doc comment on
        // mandatory-field relaxation ("never a fabricated HISTORICAL fact
        // ... a live-field default").
        priority: input.importance ?? undefined,
        departmentId: department.id,
        startDate: input.startDate ?? undefined,
        endDate: input.endDate ?? undefined,
        expectedStartDate: input.expectedStartDate ?? undefined,
        expectedFinishDate: input.expectedFinishDate ?? undefined,
        expectedTotalInitialDays,
        actualTotalDays,
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
