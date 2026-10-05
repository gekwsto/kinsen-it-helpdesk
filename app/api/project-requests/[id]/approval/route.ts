import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { projectRequestApprovalDecisionSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { decideApproval } from "@/lib/services/project-request-service";

// POST — the single Approve/Decline action on a Project Request. Authorization
// is effective projectRequest.approve for THIS request's own department
// (global grant -> every department, department-scoped grant -> that
// department only) — re-checked here server-side via
// hasEffectiveEntityPermission regardless of whether the UI showed the
// control. Never tied to the requester's own manager/org-chart in any way —
// see decideApproval's own doc comment for the full atomic guard.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    const parsed = projectRequestApprovalDecisionSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await decideApproval(
      id,
      session.user.id,
      session.user.role,
      session.user.customRoleId,
      parsed.data.decision,
      parsed.data.businessAssessment
    );
    if (!result.ok) {
      switch (result.error.code) {
        case "not_found":
          return NextResponse.json(apiError("item_not_found", "This Project Request no longer exists."), { status: 404 });
        case "forbidden":
          return forbiddenResponse("You do not have permission to approve Project Requests in this department.");
        case "invalid_status":
          return NextResponse.json(
            apiError("invalid_status", "This Project Request has already been decided.", { field: "status" }),
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
    console.error("[api/project-requests/[id]/approval] POST failed", error);
    return internalErrorResponse();
  }
}
