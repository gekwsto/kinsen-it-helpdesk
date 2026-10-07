import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { getActiveDepartmentMemberUsers } from "@/lib/services/department-membership-service";

/**
 * Read-only, any-authenticated-user list of a department's ACTIVE members
 * (active DepartmentMembership + active User) — feeds the manual Project
 * creation form's Members picker (see
 * components/projects/project-form.tsx). Deliberately membership-based, not
 * permission-based: unlike GET /api/users?assignableFor=project (which
 * additionally requires `project.assignable` — a different, narrower
 * notion, "can be assigned project WORK," see
 * assignment-eligibility-service.ts's own doc comment), a manual Project's
 * Members list means "who's in this workspace," full stop.
 *
 * Not sensitive on its own (same reasoning as
 * GET /api/departments/[id]/sub-departments) — this only ever narrows what
 * the create form OFFERS; actual admission still goes through
 * POST /api/projects's own server-side memberIds validation.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAuth();
    const { id } = await params;
    const members = await getActiveDepartmentMemberUsers(id);
    return NextResponse.json(members);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
