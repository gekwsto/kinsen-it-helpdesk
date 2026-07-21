import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireDepartmentPermission } from "@/lib/permissions";
import { updateDepartmentInboundEmailSchema } from "@/lib/validations";
import { setDepartmentInboundEmail } from "@/lib/services/department-service";

// Separate from PATCH /api/admin/departments/[id] on purpose — gated by
// department.email.manage, a different permission than the general
// department settings fields (see updateDepartmentInboundEmailSchema's
// comment in lib/validations.ts).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireDepartmentPermission(id, "department.email.manage");

    const department = await prisma.department.findUnique({ where: { id }, select: { id: true } });
    if (!department) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json();
    const data = updateDepartmentInboundEmailSchema.parse(body);
    const normalized = data.inboundEmail ? data.inboundEmail.trim().toLowerCase() : null;

    if (normalized) {
      const existing = await prisma.department.findFirst({
        where: { inboundEmail: normalized, NOT: { id } },
        select: { id: true, name: true },
      });
      if (existing) {
        return NextResponse.json(
          { error: `This email address is already used by ${existing.name}.`, code: "email_in_use" },
          { status: 409 }
        );
      }
    }

    const updated = await setDepartmentInboundEmail(id, normalized);
    return NextResponse.json({ id: updated.id, inboundEmail: updated.inboundEmail });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors[0]?.message ?? "Invalid email", code: "invalid_email" }, { status: 422 });
    }
    if (error.message === "Unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error.message === "Forbidden") return NextResponse.json({ error: "Forbidden", code: "missing_permission" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
