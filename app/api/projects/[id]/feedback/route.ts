import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { projectFeedbackSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";
import { upsertProjectFeedback } from "@/lib/services/project-feedback-service";

// POST — the ONLY way a ProjectFeedback row is ever created OR updated
// (create-or-update/upsert, never a separate second endpoint for the same
// business action). Deliberately NOT authorized through project.edit (or
// any other Project permission) — being ADMIN, a member of the full
// `owners` multi-owner set (unless also the canonical ownerId), the
// original Project Request requester (unless also ownerId), Audience, or
// a Member grants NOTHING here. The one and only identity allowed through
// is Project.ownerId — the single canonical primary Owner, re-resolved
// from the DB on every call — see lib/services/project-feedback-service.ts's
// upsertProjectFeedback for the full rule and its own doc comment for the
// race-safety strategy and legacy-provenance preservation.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    const parsed = projectFeedbackSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await upsertProjectFeedback(id, session.user.id, parsed.data);
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
            apiError("forbidden", "Only this Project's primary Owner can submit Feedback."),
            { status: 403 }
          );
        case "not_completed":
          return NextResponse.json(
            apiError("not_completed", "Feedback can only be submitted or updated while this Project is COMPLETED.", { field: "status" }),
            { status: 409 }
          );
        default:
          return internalErrorResponse();
      }
    }

    return NextResponse.json(
      {
        id: result.feedback.id,
        deliverySpeedRating: result.feedback.deliverySpeedRating,
        communicationRating: result.feedback.communicationRating,
        functionalityRating: result.feedback.functionalityRating,
        easeOfUseRating: result.feedback.easeOfUseRating,
        overallRating: result.feedback.overallRating,
        requirementsDelivered: result.feedback.requirementsDelivered,
        comments: result.feedback.comments,
        createdAt: result.feedback.createdAt,
        updatedAt: result.feedback.updatedAt,
        created: result.created,
      },
      { status: result.created ? 201 : 200 }
    );
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/projects/[id]/feedback] POST failed", error);
    return internalErrorResponse();
  }
}
