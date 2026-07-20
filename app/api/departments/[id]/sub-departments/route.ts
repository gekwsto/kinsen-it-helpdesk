import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { listSubDepartments } from "@/lib/services/sub-department-service";

/**
 * Read-only, any-authenticated-user list of a department's active
 * sub-departments — feeds the SubDepartment dropdown on ticket/project/
 * activity create/edit forms. Not admin-gated: which sub-departments exist
 * under a department isn't sensitive on its own (same reasoning as
 * GET /api/users and GET /api/admin/department-roles/options) — the actual
 * write (setting subDepartmentId on an entity) is validated server-side
 * against the entity's departmentId regardless of what this returns.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const subDepartments = await listSubDepartments(id);
    return NextResponse.json(subDepartments);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
