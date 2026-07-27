import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getEnabledActivityStatusesForDepartment } from "@/lib/services/activity-status-config";

/**
 * Read-only, any-authenticated-user list of a department's ENABLED Activity
 * Status options (status key + label + color + sortOrder) — feeds the
 * Status dropdown on the activity create/edit forms. Not admin-gated
 * (same reasoning as GET /api/departments/[id]/sub-departments): which
 * statuses are selectable for this department isn't sensitive on its own —
 * the actual write is validated server-side by PATCH/POST /api/activities
 * regardless of what this returns. Only ENABLED rows — a disabled status
 * must never be offered for a new/edited activity, even though existing
 * activities already on it keep displaying it normally elsewhere.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const statuses = await getEnabledActivityStatusesForDepartment(id);
    return NextResponse.json(statuses);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
