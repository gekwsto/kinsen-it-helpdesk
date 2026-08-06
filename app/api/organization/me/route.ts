import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getOrganizationContext } from "@/lib/services/organization-tree-service";
import { unauthorizedResponse, internalErrorResponse } from "@/lib/api-errors";

// GET /api/organization/me — the current-user organization-context DTO
// (department/manager/managementChain/directReportsCount/syncStatus). Every
// authenticated user can read their own context — no extra permission,
// same baseline-visibility rule as the tree endpoints.
export async function GET() {
  try {
    const session = await requireAuth();
    const context = await getOrganizationContext(session.user.id);
    if (!context) return internalErrorResponse();
    return NextResponse.json(context);
  } catch (error: any) {
    if (error.message === "Unauthorized") return unauthorizedResponse();
    console.error("[api/organization/me] failed", error);
    return internalErrorResponse();
  }
}
