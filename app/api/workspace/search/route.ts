import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/permissions";
import { listAccessibleWorkspaces } from "@/lib/services/workspace-service";

/**
 * Powers the workspace switcher's search box (components/workspace/workspace-selector.tsx)
 * — the workspace switcher intentionally only ever hydrates the first
 * WORKSPACE_LIST_TAKE accessible workspaces server-side (see
 * app/(main)/layout.tsx / lib/services/workspace-service.ts); anything
 * beyond that is reached through this endpoint, never by fetching everything
 * up front. Same authorization rule as the initial list — listAccessibleWorkspaces
 * scopes to every active department for a canViewAllDepartments role
 * (ADMIN/DIRECTOR), or only the caller's own active memberships otherwise —
 * this route never widens access beyond what the user could already see.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const q = req.nextUrl.searchParams.get("q") ?? "";
    const workspaces = await listAccessibleWorkspaces(session.user.id, session.user.role, { search: q });
    return NextResponse.json({ workspaces });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
