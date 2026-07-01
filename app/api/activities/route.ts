import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { createActivitySchema } from "@/lib/validations";
import { ActivityStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);

    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");
    const assignedUserId = searchParams.get("assignedUserId");

    const where: any = {};
    if (projectId) where.projectId = projectId;
    // Validate status against the ActivityStatus enum before using in Prisma query
    const validStatuses = Object.values(ActivityStatus) as string[];
    if (status && validStatuses.includes(status)) where.status = status as ActivityStatus;
    if (assignedUserId) where.assignedUserId = assignedUserId;

    const activities = await prisma.projectActivity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(activities);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const canCreate = await hasPermission(session.user.role, "activity.create", session.user.customRoleId);
    if (!canCreate) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const data = createActivitySchema.parse(body);
    const { dueDate, startDate, ...rest } = data;

    const activity = await prisma.projectActivity.create({
      data: {
        ...rest,
        startDate: startDate ? new Date(startDate) : undefined,
        dueDate: dueDate ? new Date(dueDate) : undefined,
        createdById: session.user.id,
      },
      include: {
        project: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    return NextResponse.json(activity, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
