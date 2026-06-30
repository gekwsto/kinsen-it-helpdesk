import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { createGoalSchema } from "@/lib/validations";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "goal.view");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = new URL(req.url);
    const year = searchParams.get("year");
    const status = searchParams.get("status");

    const where: any = {};
    if (year) where.year = parseInt(year);
    if (status) where.status = status;

    const goals = await prisma.yearlyGoal.findMany({
      where,
      orderBy: [{ year: "desc" }, { createdAt: "desc" }],
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        projects: { select: { id: true, title: true, status: true } },
      },
    });

    return NextResponse.json(goals);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();
    const allowed = await hasPermission(session.user.role, "goal.create");
    if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const data = createGoalSchema.parse(body);
    const { projectIds, ...rest } = data;

    const goal = await prisma.yearlyGoal.create({
      data: {
        ...rest,
        ownerUserId: session.user.id,
        projects: projectIds.length
          ? { connect: projectIds.map((id) => ({ id })) }
          : undefined,
      },
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        projects: { select: { id: true, title: true, status: true } },
      },
    });

    return NextResponse.json(goal, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
