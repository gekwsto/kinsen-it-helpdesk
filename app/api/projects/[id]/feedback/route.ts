import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { projectFeedbackSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";
import { submitProjectFeedback } from "@/lib/services/project-feedback-service";

// POST — the ONLY way a ProjectFeedback row is ever created. Deliberately
// NOT authorized through project.edit (or any other Project permission) —
// being ADMIN, the Project Owner, a Project Manager, the final approver,
// or a department admin grants NOTHING here. The one and only identity
// allowed through is the original Project Request's own requesterId,
// re-resolved from the DB on every call — see
// lib/services/project-feedback-service.ts's submitProjectFeedback for the
// full rule and its own doc comment for the race-safety strategy.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    const parsed = projectFeedbackSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await submitProjectFeedback(id, session.user.id, parsed.data);
    if (!result.ok) {
      switch (result.error.code) {
        case "not_found":
          return NextResponse.json(apiError("item_not_found", "This Project no longer exists."), { status: 404 });
        case "not_request_origin":
          return NextResponse.json(
            apiError("not_request_origin", "This Project did not originate from a Project Request — Feedback does not apply to it."),
            { status: 403 }
          );
        case "forbidden":
          return NextResponse.json(
            apiError("forbidden", "Only the original requester of this Project's Project Request can submit Feedback."),
            { status: 403 }
          );
        case "not_completed":
          return NextResponse.json(
            apiError("not_completed", "Feedback can only be submitted once this Project is COMPLETED.", { field: "status" }),
            { status: 409 }
          );
        default:
          return internalErrorResponse();
      }
    }

    // alreadyExisted:true (a duplicate/race submission) still returns 200
    // with the EXISTING row — never a second row, never an error the
    // client would need to special-case; the client's own "replace the
    // form with a readonly result" behavior is identical either way.
    return NextResponse.json(
      {
        id: result.feedback.id,
        satisfactionScore: result.feedback.satisfactionScore,
        comments: result.feedback.comments,
        createdAt: result.feedback.createdAt,
        alreadyExisted: result.alreadyExisted,
      },
      { status: result.alreadyExisted ? 200 : 201 }
    );
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/projects/[id]/feedback] POST failed", error);
    return internalErrorResponse();
  }
}
