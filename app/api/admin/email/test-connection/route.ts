import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/permissions";
import { microsoftGraph } from "@/lib/microsoft-graph";
import { listConfiguredDepartmentMailboxes } from "@/lib/services/inbound-mailbox-service";

// Still tests the central mailbox exactly as before (the top-level tokenOk/
// mailboxOk/mailboxEmail/unreadCount/error/details fields, unchanged shape)
// — additionally tests every configured department mailbox too (active
// AND inactive, so an admin can see a stale/misconfigured address even for
// a department that isn't currently being polled), so a department address
// Graph can't actually reach (e.g. a distribution-only address, or one
// simply mistyped) is obvious here instead of silently doing nothing during
// a real poll.
export async function POST() {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [central, departmentMailboxes] = await Promise.all([
      microsoftGraph.testConnection(),
      listConfiguredDepartmentMailboxes(),
    ]);

    // Sequential, not Promise.all — this is an admin-triggered, infrequent
    // diagnostic action (matches this codebase's existing preference for
    // predictable, bounded Graph call patterns over unbounded parallel
    // fan-out), and the department list is realistically small.
    const departments: Array<{
      departmentId: string;
      departmentName: string;
      email: string;
      isActive: boolean;
      ok: boolean;
      unreadCount?: number;
      error?: string;
    }> = [];
    for (const dept of departmentMailboxes) {
      const result = await microsoftGraph.testMailboxAccess(dept.email);
      departments.push({
        departmentId: dept.departmentId,
        departmentName: dept.departmentName,
        email: dept.email,
        isActive: dept.isActive,
        ok: result.ok,
        unreadCount: result.unreadCount,
        error: result.error,
      });
    }

    return NextResponse.json({ ...central, departmentMailboxes: departments });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message ?? "Test failed" },
      { status: 500 }
    );
  }
}
