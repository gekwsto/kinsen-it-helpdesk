import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { reorderActivitiesSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";
import { reorderProjectActivities } from "@/lib/services/activity-sequence-service";
import { publishActivityListInvalidation } from "@/lib/realtime/activity-list-invalidation";

// PATCH — the ONLY way ProjectActivity.sequence is ever reordered. Applies
// ONLY to a request-origin Project (Project.projectRequestId != null) —
// re-verified server-side from the Project row itself, never trusted from
// any client flag/route. Authorized by activity.edit, the SAME canonical
// permission every other Activity mutation in this app already requires —
// never a new permission, never bare project.view. See
// lib/services/activity-sequence-service.ts's reorderProjectActivities for
// the full validation/atomicity contract.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    const parsed = reorderActivitiesSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await reorderProjectActivities(id, parsed.data.activityIds, {
      id: session.user.id,
      role: session.user.role,
      customRoleId: session.user.customRoleId,
    });

    if (!result.ok) {
      switch (result.error.code) {
        case "project_not_found":
          return NextResponse.json(apiError("item_not_found", "This Project no longer exists."), { status: 404 });
        case "not_request_origin":
          return NextResponse.json(
            apiError("not_request_origin", "This Project did not originate from a Project Request — Activity sequencing does not apply to it."),
            { status: 403 }
          );
        case "forbidden":
          return NextResponse.json(apiError("missing_permission", "You don't have permission to reorder Activities in this Project."), { status: 403 });
        case "invalid_activity_ids":
          return NextResponse.json(
            apiError("invalid_activity_ids", "The submitted Activity list does not match this Project's current Activities exactly — no duplicates, no unknown ids, no partial list."),
            { status: 400 }
          );
        default:
          return internalErrorResponse();
      }
    }

    // Published only after the reorder has actually committed — same
    // convention as every other Activity mutation in this app. The Project
    // detail page's own sequence card updates its local state directly
    // from this request's own response (no realtime subscription exists
    // for that card today — see its own doc comment); this publish is for
    // the unrelated /activities list page, which DOES subscribe, in case
    // it's open in another tab and cares about this Project's Activities.
    publishActivityListInvalidation();

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/projects/[id]/activities/order] PATCH failed", error);
    return internalErrorResponse();
  }
}
