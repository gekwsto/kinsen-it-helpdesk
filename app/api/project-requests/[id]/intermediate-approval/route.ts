import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { projectRequestIntermediateApprovalDecisionSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { decideIntermediateApproval } from "@/lib/services/project-request-service";

// POST — the Approve/Reject action for the INTERMEDIATE stage (ahead of the
// pre-existing final /approval route). Authorization requires BOTH:
// (1) the caller genuinely holds projectRequest.intermediateApprove
// globally right now, AND (2) the requester explicitly selected this exact
// caller as one of THIS request's own intermediate approvers at submission
// time — re-checked here server-side regardless of what the UI showed, via
// decideIntermediateApproval's own atomic, race-safe guard (see its doc
// comment). Never department-scoped, never derived from org-chart
// management.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    const parsed = projectRequestIntermediateApprovalDecisionSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await decideIntermediateApproval(id, session.user.id, session.user.role, session.user.customRoleId, parsed.data.decision, parsed.data.businessAssessment);
    if (!result.ok) {
      switch (result.error.code) {
        case "not_found":
          return NextResponse.json(apiError("item_not_found", "This Project Request no longer exists."), { status: 404 });
        case "forbidden":
          return forbiddenResponse("You are not an intermediate approver for this Project Request.");
        case "invalid_status":
          return NextResponse.json(
            apiError("invalid_status", "This Project Request is no longer awaiting your intermediate approval.", { field: "status" }),
            { status: 409 }
          );
        case "invalid_assessment":
          return NextResponse.json(
            apiError("invalid_assessment", "Business Assessment is required.", { field: "businessAssessment" }),
            { status: 422 }
          );
        default:
          return internalErrorResponse();
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/project-requests/[id]/intermediate-approval] POST failed", error);
    return internalErrorResponse();
  }
}
