import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission, requireDepartmentPermission } from "@/lib/permissions";
import { rejectPendingTicket } from "@/lib/services/pending-ticket-service";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();

    const pendingTicket = await prisma.pendingTicket.findUnique({
      where: { id },
      select: { departmentId: true },
    });
    if (!pendingTicket) return NextResponse.json({ error: "Not found", code: "ticket_not_found" }, { status: 404 });

    if (pendingTicket.departmentId) {
      try {
        await requireDepartmentPermission(pendingTicket.departmentId, "ticket.pending.reject");
      } catch {
        return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
      }
    } else {
      const allowed = await hasPermission(session.user.role, "ticket.pending.reject", session.user.customRoleId);
      if (!allowed) return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    const result = await rejectPendingTicket(id, session.user.id);
    if (!result.ok) {
      const status = result.error === "ticket_not_found" ? 404 : 409;
      return NextResponse.json({ error: result.error, code: result.error }, { status });
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
