import { NextRequest, NextResponse } from "next/server";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { createHistoricalProjectRequestSchema } from "@/lib/validations";
import { apiError, zodErrorResponse, unauthorizedResponse, forbiddenResponse, internalErrorResponse } from "@/lib/api-errors";
import { createHistoricalProjectRequest } from "@/lib/services/project-request-historical-import-service";

/**
 * POST — the ONE privileged entry point for Historical Import (Phase 3).
 * Gated by `projectRequest.historicalImport`, a dedicated permission with
 * NO default grants (ADMIN only, via hasPermission's own unconditional
 * role===ADMIN shortcut — see this key's own seed comment) — deliberately
 * NEVER reachable from the standard, user-facing
 * POST /api/project-requests endpoint, and never implied by
 * projectRequest.approve or any other Project Request permission.
 *
 * This route is the generic "create ONE historical request + its linked
 * Project" primitive — it does NOT read or map any external file (Excel or
 * otherwise); that mapping is an explicitly separate, later piece of work
 * (see this feature's own "Do not map or import the Excel data yet").
 *
 * Date-ish string fields (submittedAt/approvedAt/startDate/endDate) are
 * parsed here, at the HTTP boundary, into real Date objects before
 * reaching the service — the service itself only ever deals in Date |
 * null | undefined, never raw strings.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "projectRequest.historicalImport", session.user.customRoleId);
    if (!allowed) return forbiddenResponse("You don't have permission to create Historical Import Project Requests.");

    const body = await req.json();
    const parsed = createHistoricalProjectRequestSchema.safeParse(body);
    if (!parsed.success) return zodErrorResponse(parsed.error);
    const data = parsed.data;

    const result = await createHistoricalProjectRequest({
      title: data.title,
      description: data.description,
      importance: data.importance,
      teamConcerned: data.teamConcerned,
      expectedBenefits: data.expectedBenefits,
      replacesExisting: data.replacesExisting,
      replacementDescription: data.replacementDescription ?? null,
      externalSourceId: data.externalSourceId,
      departmentId: data.departmentId,
      requesterId: data.requesterId ?? null,
      requesterDepartmentId: data.requesterDepartmentId ?? null,
      submittedAt: data.submittedAt ? new Date(data.submittedAt) : null,
      approverId: data.approverId ?? null,
      approvedAt: data.approvedAt ? new Date(data.approvedAt) : null,
      businessAssessment: data.businessAssessment ?? null,
      projectStatus: data.projectStatus,
      projectTitle: data.projectTitle,
      projectDescription: data.projectDescription,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      expectedStartDate: data.expectedStartDate ? new Date(data.expectedStartDate) : null,
      expectedFinishDate: data.expectedFinishDate ? new Date(data.expectedFinishDate) : null,
      historicalSourceMetadata: data.historicalSourceMetadata ?? null,
      ownerIds: data.ownerIds,
      audienceIds: data.audienceIds,
      audienceDepartmentIds: data.audienceDepartmentIds,
      audienceBusinessUnitIds: data.audienceBusinessUnitIds,
      responsiblePeopleIds: data.responsiblePeopleIds,
    });

    if (!result.ok) {
      const fieldByCode: Record<string, string> = {
        invalid_department: "departmentId",
        invalid_project_owner: "ownerIds",
        invalid_audience: "audienceIds",
        invalid_audience_department: "audienceDepartmentIds",
        invalid_audience_business_unit: "audienceBusinessUnitIds",
        invalid_responsible_people: "responsiblePeopleIds",
        invalid_requester: "requesterId",
        invalid_requester_department: "requesterDepartmentId",
        invalid_approver: "approverId",
        external_source_id_conflict: "externalSourceId",
      };
      const messageByCode: Record<string, string> = {
        invalid_department: "The selected Department does not exist or is not active.",
        invalid_project_owner: "Select at least one real, active user to own this Project.",
        invalid_audience: "One or more selected Audience users are not real, active users.",
        invalid_audience_department: "One or more selected Audience Departments do not exist or are not active.",
        invalid_audience_business_unit: "One or more selected Audience Business Units do not exist.",
        invalid_responsible_people: "One or more selected Responsible People are not real, active users.",
        invalid_requester: "The selected Requester does not exist.",
        invalid_requester_department: "The selected Requester Department does not exist.",
        invalid_approver: "The selected Approver does not exist.",
        external_source_id_conflict: "This External Source Id is already used by a Project Request with a different import payload (e.g. different Owners, Audiences, dates, or other persisted field) — resolve the conflict before retrying.",
      };
      const code = result.error.code;
      return NextResponse.json(apiError(code, messageByCode[code] ?? code, { field: fieldByCode[code] }), { status: 422 });
    }

    return NextResponse.json(
      { projectRequestId: result.projectRequestId, projectId: result.projectId, alreadyExisted: result.alreadyExisted },
      { status: result.alreadyExisted ? 200 : 201 }
    );
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/admin/project-requests/historical-import] POST failed", error);
    return internalErrorResponse();
  }
}
