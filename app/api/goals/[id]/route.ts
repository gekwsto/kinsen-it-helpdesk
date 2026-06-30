import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { updateGoalSchema } from "@/lib/validations";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "goal.view");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const goal = await prisma.yearlyGoal.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        projects: {
          select: {
            id: true,
            title: true,
            status: true,
            _count: { select: { activities: true } },
          },
        },
      },
    });

    if (!goal) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(goal);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "goal.edit");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const data = updateGoalSchema.parse(body);
    const { projectIds, ...rest } = data;

    const goal = await prisma.yearlyGoal.update({
      where: { id },
      data: {
        ...rest,
        ...(projectIds !== undefined && {
          projects: { set: projectIds.map((pid) => ({ id: pid })) },
        }),
      },
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        projects: { select: { id: true, title: true, status: true } },
      },
    });

    return NextResponse.json(goal);
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "goal.delete");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    await prisma.yearlyGoal.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
