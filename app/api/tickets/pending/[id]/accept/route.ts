import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission, requireDepartmentPermission } from "@/lib/permissions";
import { acceptPendingTicket } from "@/lib/services/pending-ticket-service";

const acceptSchema = z.object({
  departmentId: z.string().nullable().optional(),
});

export async function POST(
  req: NextRequest,
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

    // Department-scoped when the pending ticket already has one; otherwise
    // (no department matched at receipt time) only a global
    // ticket.pending.accept grant can act on it — mirrors how
    // buildPendingTicketListWhere only shows unmatched rows to Admin/Director.
    if (pendingTicket.departmentId) {
      try {
        await requireDepartmentPermission(pendingTicket.departmentId, "ticket.pending.accept");
      } catch {
        return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
      }
    } else {
      const allowed = await hasPermission(session.user.role, "ticket.pending.accept", session.user.customRoleId);
      if (!allowed) return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const data = acceptSchema.parse(body);

    const result = await acceptPendingTicket(id, session.user.id, data.departmentId ?? undefined);
    if (!result.ok) {
      const status = result.error === "ticket_not_found" ? 404 : result.error === "invalid_department" ? 400 : 409;
      return NextResponse.json({ error: result.error, code: result.error }, { status });
    }

    return NextResponse.json(result.ticket);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
