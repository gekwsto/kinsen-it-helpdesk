import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireAuth, canViewAllDepartments } from "@/lib/permissions";
import { getMembership } from "@/lib/services/department-membership-service";
import { getDepartmentById } from "@/lib/services/department-service";
import { ACTIVE_WORKSPACE_COOKIE, ALL_WORKSPACES_VALUE } from "@/lib/services/workspace-service";

/**
 * Switches the caller's active workspace. Always validates server-side
 * before writing the cookie — a client can request any departmentId, but
 * only one they actually have standing in (or, for ADMIN, any active
 * department) ever gets persisted.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const body = await req.json().catch(() => null);
    const departmentId = typeof body?.departmentId === "string" ? body.departmentId : null;
    if (!departmentId) {
      return NextResponse.json({ error: "departmentId is required" }, { status: 400 });
    }

    if (departmentId === ALL_WORKSPACES_VALUE) {
      if (!canViewAllDepartments(session.user.role)) {
        return NextResponse.json({ error: "You don't have access to All Workspaces" }, { status: 403 });
      }
    } else if (canViewAllDepartments(session.user.role)) {
      const department = await getDepartmentById(departmentId);
      if (!department || !department.isActive) {
        return NextResponse.json({ error: "Invalid department" }, { status: 400 });
      }
    } else {
      const membership = await getMembership(session.user.id, departmentId);
      if (!membership) {
        return NextResponse.json({ error: "You don't have access to this department" }, { status: 403 });
      }
    }

    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_WORKSPACE_COOKIE, departmentId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });

    return NextResponse.json({ departmentId });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
