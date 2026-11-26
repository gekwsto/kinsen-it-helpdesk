import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { createProjectFromRequestSchema, facilitiesProjectFieldsSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { createProjectFromApprovedRequest } from "@/lib/services/project-request-service";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";

// POST — turns an APPROVED Project Request into a real Project. A
// deliberately SEPARATE mutation from POST .../approval and from the
// normal POST /api/projects — see createProjectFromApprovedRequest's own
// doc comment for the exact authorization boundary (anyone who currently
// holds effective projectRequest.approve for this request's own
// department, on a genuinely APPROVED request with no Project yet — not
// tied to the one specific person who originally clicked Approve). The
// department is never accepted from the request body — it always comes
// from the Project Request itself, resolved server-side.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    // createProjectFromRequestSchema is a ZodEffects (its own trailing
    // .superRefine), which has no .merge() — .and() (ZodIntersection) works
    // on any ZodType and merges both objects' parsed results the same way.
    const parsed = createProjectFromRequestSchema.and(facilitiesProjectFieldsSchema).safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await createProjectFromApprovedRequest(id, session.user.id, session.user.role, session.user.customRoleId, parsed.data);
    if (!result.ok) {
      switch (result.error.code) {
        case "not_found":
          return NextResponse.json(apiError("item_not_found", "This Project Request no longer exists."), { status: 404 });
        case "forbidden":
          return forbiddenResponse("You need final-approval rights for this department to complete this Project Request's setup.");
        case "forbidden_destination":
          return forbiddenResponse("You can't create a Project in the selected Workspace. Choose the request's Workspace or one where you're allowed to create Projects.");
        case "invalid_status":
          return NextResponse.json(
            apiError("invalid_status", "This Project Request must be APPROVED before its Project can be set up.", { field: "status" }),
            { status: 409 }
          );
        case "not_standard_request":
          return NextResponse.json(
            apiError("not_standard_request", "This Project Request is a historical import and is not eligible for normal Project setup — it already has a linked Project."),
            { status: 409 }
          );
        case "invalid_project_owner":
          return NextResponse.json(
            apiError("invalid_project_owner", "Select at least one real, active user to own this Project.", { field: "ownerIds" }),
            { status: 422 }
          );
        case "invalid_audience":
          return NextResponse.json(
            apiError("invalid_audience", "One or more selected Audience users are not real, active users.", { field: "audienceIds" }),
            { status: 422 }
          );
        case "invalid_audience_department":
          return NextResponse.json(
            apiError("invalid_audience_department", "One or more selected Audience Departments do not exist or are not active.", { field: "audienceDepartmentIds" }),
            { status: 422 }
          );
        case "invalid_audience_business_unit":
          return NextResponse.json(
            apiError("invalid_audience_business_unit", "One or more selected Audience Business Units do not exist.", { field: "audienceBusinessUnitIds" }),
            { status: 422 }
          );
        case "audience_business_units_not_allowed":
          return NextResponse.json(
            apiError("audience_business_units_not_allowed", "Business Units cannot be selected as Audience when creating a Project from a Project Request.", { field: "audienceBusinessUnitIds" }),
            { status: 422 }
          );
        case "invalid_responsible_people":
          return NextResponse.json(
            apiError("invalid_responsible_people", "One or more selected Responsible People are not real, active users.", { field: "responsiblePeopleIds" }),
            { status: 422 }
          );
        case "invalid_expense_type":
          return NextResponse.json(
            apiError("invalid_expense_type", "Select a real, active Expense Type.", { field: "expenseTypeId" }),
            { status: 422 }
          );
        case "invalid_sub_department":
          return NextResponse.json(
            apiError("invalid_sub_department", "The selected sub-department does not belong to this project's department.", { field: "subDepartmentId" }),
            { status: 400 }
          );
        case "invalid_member":
          return NextResponse.json(
            apiError("invalid_member", "One or more selected members cannot be assigned to projects in this department.", { field: "memberIds" }),
            { status: 400 }
          );
        case "facilities_fields_not_allowed":
          return NextResponse.json(
            apiError("facilities_fields_not_allowed", "Facilities-specific fields can only be set for a Project in the Facilities Services workspace."),
            { status: 400 }
          );
        case "facilities_quarter_fields_incomplete":
          return NextResponse.json(
            apiError("facilities_quarter_fields_incomplete", `Select both a Quarter and a Year for ${result.error.field === "start" ? "Start" : "End"}.`),
            { status: 400 }
          );
        case "facilities_invalid_date_range":
          return NextResponse.json(apiError("facilities_invalid_date_range", "Start must not be later than End."), { status: 400 });
        default:
          return internalErrorResponse();
      }
    }

    // Published only on a GENUINE new creation — reopening/resubmitting an
    // already-set-up request's own setup page resolves to the existing
    // Project without a redundant publish.
    if (!result.alreadyExisted) {
      publishProjectListInvalidation();
    }

    return NextResponse.json({ id: result.projectId, alreadyExisted: result.alreadyExisted }, { status: result.alreadyExisted ? 200 : 201 });
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/project-requests/[id]/project] POST failed", error);
    return internalErrorResponse();
  }
}
