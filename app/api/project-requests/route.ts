import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { createProjectRequestSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";
import { resolveDepartmentForRequest, resolveIntermediateApprovers, notifyIntermediateApprovers, notifyEligibleApproversOfSubmission, notifyEligibleApproversReadyForProjectCreation, nextProjectRequestStatus } from "@/lib/services/project-request-service";
import { canSkipFinalApproval } from "@/lib/services/project-request-approver-eligibility-service";
import { scheduleSetupReminderInTx } from "@/lib/services/project-request-setup-reminder-service";

// POST — submit a new Project Request. Every trust-sensitive field
// (requesterId, department membership, status) is resolved/verified
// SERVER-SIDE only — the client never supplies, and the server never
// trusts, an id for any of them. Submission itself needs no special
// permission beyond an active department membership (or, for a
// global-scope role, canViewAllDepartments) — ANY authenticated user may
// submit a request; approval is a separate, department-scoped permission
// checked only later, at decision time. See
// lib/services/project-request-service.ts for resolveDepartmentForRequest.
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const body = await req.json();
    const parsed = createProjectRequestSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const data = parsed.data;

    // Department: resolved from the SAME canonical accessible-departments
    // set the workspace selector uses (see resolveDepartmentForRequest's own
    // doc comment) — a single accessible department is auto-selected; more
    // than one requires an explicit, real match — a forged departmentId (or
    // the synthetic "All Workspaces" value) is rejected here, never
    // silently accepted or substituted.
    const departmentResolution = await resolveDepartmentForRequest(session.user.id, session.user.role, data.departmentId);
    if (!departmentResolution.ok) {
      const message =
        departmentResolution.reason === "no_department"
          ? "You don't belong to any active department, so you can't submit a Project Request."
          : departmentResolution.reason === "ambiguous"
          ? "You belong to more than one department — select which one this request is for."
          : departmentResolution.reason === "all_workspaces_not_allowed"
          ? "Select a specific department — \"All Workspaces\" isn't a real department."
          : "You don't have access to the selected department.";
      return NextResponse.json(apiError("invalid_department", message, { field: "departmentId" }), { status: 400 });
    }

    // Project Type (the former ProjectRequestType) is deliberately no
    // longer accepted/validated here at all — that classification moved
    // to Activity (see TaskType in prisma/schema.prisma). ProjectRequest.
    // projectTypeId is simply never set for a new request below.

    // The canonical server-side invariant — never trusted from client state
    // or HTML `required` alone (createProjectRequestSchema's .superRefine
    // already rejects a missing/empty value when replacesExisting is true,
    // so reaching this line with replacesExisting true guarantees
    // data.replacementDescription is a real, trimmed, non-empty string).
    // When replacesExisting is false, ANY value the client sent is
    // discarded here — this always persists null, never a forged/stale
    // string.
    const replacementDescription = data.replacesExisting ? data.replacementDescription! : null;

    // Skip Final Approval — only with the requester's EFFECTIVE
    // projectRequest.skipFinalApproval for the RESOLVED target department
    // (Global or Department scope). An unauthorized attempt is rejected,
    // never silently downgraded to a normal submission.
    if (data.skipFinalApproval) {
      const allowed = await canSkipFinalApproval(session.user.id, session.user.role, session.user.customRoleId, departmentResolution.departmentId);
      if (!allowed) {
        return NextResponse.json(
          apiError("skip_final_approval_not_allowed", "You are not allowed to skip Final Approval for this department.", { field: "skipFinalApproval" }),
          { status: 403 }
        );
      }
    }

    // Intermediate Approval opt-out is available to every requester.
    const intermediateResolution = await resolveIntermediateApprovers(session.user.id, data.intermediateApproverIds, data.skipIntermediateApproval);
    if (!intermediateResolution.ok) {
      const message =
        intermediateResolution.reason === "no_approvers_selected"
          ? "Select your manager as the intermediate approver."
          : intermediateResolution.reason === "unresolved_manager"
            ? (intermediateResolution.detail ?? "Could not verify your manager right now. Please try again, or contact an administrator.")
            : "The selected intermediate approver is not your verified manager. Please re-select.";
      return NextResponse.json(apiError("invalid_intermediate_approvers", message, { field: "intermediateApproverIds" }), { status: 400 });
    }

    // Requester Department — a one-time SNAPSHOT of the requester's own
    // department at submission, completely independent of departmentId
    // above (the TARGET department this request is FOR). Resolved from
    // User.departmentId — the legacy "home department" FK that
    // setPrimaryDepartmentMembership keeps in sync with whichever
    // DepartmentMembership row is flagged isPrimary (see that function's
    // own doc comment) — the one existing, already-canonical "this user's
    // single department" value used elsewhere in the app (e.g. it's what
    // populates session.user.departmentId). Read FRESH from the database
    // here rather than trusted from the session/JWT, which is only
    // refreshed at sign-in and could be stale if an admin changed this
    // user's primary department earlier in the same session. Never
    // accepted from the request body at all (not merely ignored — there is
    // no such key anywhere in createProjectRequestSchema), so a client can
    // never spoof it. Null when the requester currently has no primary
    // department — stored as null, rendered as "Not recorded", never
    // guessed.
    const requesterForDepartmentSnapshot = await prisma.user.findUnique({ where: { id: session.user.id }, select: { departmentId: true } });
    const requesterDepartmentId = requesterForDepartmentSnapshot?.departmentId ?? null;

    // The ProjectRequest row and (when the intermediate stage isn't being
    // skipped) its full set of ProjectRequestIntermediateApprover rows are
    // created atomically.
    const initialStatus = nextProjectRequestStatus("submitted", {
      intermediateRequired: !intermediateResolution.skipIntermediateStage,
      finalRequired: !data.skipFinalApproval,
    });
    const submittedAt = new Date();

    const created = await prisma.$transaction(async (tx) => {
      const request = await tx.projectRequest.create({
        data: {
          title: data.title,
          description: data.description,
          importance: data.importance,
          teamConcerned: data.teamConcerned,
          expectedBenefits: data.expectedBenefits,
          replacesExisting: data.replacesExisting,
          replacementDescription,
          requesterId: session.user.id,
          departmentId: departmentResolution.departmentId,
          requesterDepartmentId,
          // Explicit, even though it's also the column default — every
          // request submitted through this normal, user-facing endpoint is
          // a STANDARD request; Historical Import is a separate, privileged
          // mechanism (see lib/services/project-request-historical-import-
          // service.ts) never reachable from here.
          source: "STANDARD",
          // status defaults to PENDING_INTERMEDIATE_APPROVAL at the schema
          // level — overridden to PENDING_APPROVAL only when the requester
          // has a VERIFIED "no manager" record, or holds
          // projectRequest.skipIntermediateApproval (skipIntermediateStage).
          // intermediateApprovalSkipReason records WHICH of the two it was,
          // for audit — null whenever the normal unanimous flow applies
          // (REQUIRED #4).
          // Initial status from the canonical stage machine
          // (nextProjectRequestStatus). Both skip decisions are persisted;
          // a skipped stage never records an approver or approval time.
          status: initialStatus,
          intermediateApprovalSkipReason: intermediateResolution.skipIntermediateStage ? intermediateResolution.skipReason : null,
          ...(data.skipFinalApproval ? { finalApprovalSkipped: true, finalApprovalSkippedById: session.user.id, finalApprovalSkippedAt: submittedAt } : {}),
          submittedAt,
        },
        select: { id: true, title: true },
      });
      // Both stages skipped: APPROVED at submission (no decision fabricated) —
      // the same Project-setup reminder an ordinary final approval schedules.
      if (initialStatus === "APPROVED") {
        await scheduleSetupReminderInTx(tx, request.id, submittedAt);
      }
      if (intermediateResolution.approverIds.length > 0) {
        await tx.projectRequestIntermediateApprover.createMany({
          data: intermediateResolution.approverIds.map((approverId) => ({ projectRequestId: request.id, approverId })),
        });
      }
      return request;
    });

    // Best-effort, AFTER the rows have genuinely committed above — a
    // notification failure must never turn an already-successful submission
    // into an error response.
    // Notify only the stage that is actually next. Nobody is asked to act on a
    // skipped stage; a request approved at submission notifies no approver.
    if (initialStatus === "PENDING_INTERMEDIATE_APPROVAL") {
      await notifyIntermediateApprovers(created.id, created.title, intermediateResolution.approverIds);
    } else if (initialStatus === "PENDING_APPROVAL") {
      await notifyEligibleApproversOfSubmission(departmentResolution.departmentId, created.id, created.title);
    } else if (initialStatus === "APPROVED") {
      // Both stages skipped: approved at submission — ready for Project Creation.
      await notifyEligibleApproversReadyForProjectCreation(departmentResolution.departmentId, created.id, created.title);
    }


    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/project-requests] POST failed", error);
    return internalErrorResponse();
  }
}
