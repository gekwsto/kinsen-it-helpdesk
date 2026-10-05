import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { createProjectFromRequestSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { createProjectFromApprovedRequest } from "@/lib/services/project-request-service";
import { publishProjectListInvalidation } from "@/lib/realtime/project-list-invalidation";

// POST — turns an APPROVED Project Request into a real Project. A
// deliberately SEPARATE mutation from POST .../approval and from the
// normal POST /api/projects — see createProjectFromApprovedRequest's own
// doc comment for the exact authorization boundary (the EXACT recorded
// final approver, on a genuinely APPROVED request with no Project yet; no
// generic project.create requirement, and no ADMIN identity bypass). The
// department is never accepted from the request body — it always comes
// from the Project Request itself, resolved server-side.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAuth();
    const { id } = await params;

    const body = await req.json();
    const parsed = createProjectFromRequestSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);

    const result = await createProjectFromApprovedRequest(id, session.user.id, parsed.data);
    if (!result.ok) {
      switch (result.error.code) {
        case "not_found":
          return NextResponse.json(apiError("item_not_found", "This Project Request no longer exists."), { status: 404 });
        case "forbidden":
          return forbiddenResponse("Only the approver who gave final approval on this Project Request can complete its Project setup.");
        case "invalid_status":
          return NextResponse.json(
            apiError("invalid_status", "This Project Request must be APPROVED before its Project can be set up.", { field: "status" }),
            { status: 409 }
          );
        case "invalid_project_owner":
          return NextResponse.json(
            apiError("invalid_project_owner", "Select a real, active user who can own a Project in this department.", { field: "projectOwnerId" }),
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
