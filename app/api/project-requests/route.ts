import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import { createProjectRequestSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";
import { resolveDepartmentForRequest, resolveIntermediateApprovers, notifyIntermediateApprovers } from "@/lib/services/project-request-service";

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

    // Intermediate approvers: the requester's OWN selection, re-verified
    // here against who ACTUALLY holds projectRequest.intermediateApprove
    // GLOBALLY right now — a single forged/stale id fails the WHOLE
    // submission (fail closed), never silently dropped or skipped. This is
    // the mandatory gate ahead of final approval; there is no path that
    // creates a ProjectRequest without at least one real intermediate
    // approver.
    const intermediateResolution = await resolveIntermediateApprovers(data.intermediateApproverIds);
    if (!intermediateResolution.ok) {
      const message =
        intermediateResolution.reason === "no_approvers_selected"
          ? "Select at least one intermediate approver."
          : "One or more selected intermediate approvers are no longer eligible. Please re-select.";
      return NextResponse.json(apiError("invalid_intermediate_approvers", message, { field: "intermediateApproverIds" }), { status: 400 });
    }

    // The ProjectRequest row and its full set of
    // ProjectRequestIntermediateApprover rows are created atomically — a
    // request can never exist with zero approvers because one half of this
    // write failed.
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
          // status defaults to PENDING_INTERMEDIATE_APPROVAL at the schema
          // level — the mandatory intermediate stage, never skipped.
        },
        select: { id: true, title: true },
      });
      await tx.projectRequestIntermediateApprover.createMany({
        data: intermediateResolution.approverIds.map((approverId) => ({ projectRequestId: request.id, approverId })),
      });
      return request;
    });

    // Best-effort, AFTER the rows have genuinely committed above — a
    // notification failure must never turn an already-successful submission
    // into an error response. Only the SELECTED intermediate approvers are
    // notified now; the final stage's own eligible approvers are
    // deliberately notified later, only once intermediate approval is
    // unanimously complete (see decideIntermediateApproval) — never at
    // submission time, never a misleading "ready for final approval"
    // notification before that.
    await notifyIntermediateApprovers(created.id, created.title, intermediateResolution.approverIds);

    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/project-requests] POST failed", error);
    return internalErrorResponse();
  }
}
