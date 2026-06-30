import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import { updateActivitySchema } from "@/lib/validations";
import { recalculateProjectRollup, calculateActivityProgress } from "@/lib/projects/progress-rollup";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireAuth();
    const activity = await prisma.projectActivity.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
      },
    });

    if (!activity) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(activity);
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
    const canEdit = await hasPermission(session.user.role, "activity.edit", session.user.customRoleId);
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const data = updateActivitySchema.parse(body);
    const { dueDate, startDate, isCompleted, ...rest } = data;

    const activity = await prisma.projectActivity.update({
      where: { id },
      data: {
        ...rest,
        startDate: startDate ? new Date(startDate) : startDate === null ? null : undefined,
        dueDate: dueDate ? new Date(dueDate) : dueDate === null ? null : undefined,
        isCompleted: isCompleted ?? undefined,
        completedAt: isCompleted ? new Date() : isCompleted === false ? null : undefined,
      },
      include: {
        project: { select: { id: true, title: true } },
        assignedUser: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    // Recalculate progress rollup when activity progress or status changes
    const progressOrStatusChanged = data.progress !== undefined || data.status !== undefined;
    if (progressOrStatusChanged) {
      if (activity.project?.id) {
        recalculateProjectRollup(activity.project.id).catch((err) => {
          console.error("[progress-rollup] activity change recalculation failed:", err);
        });
      } else {
        // Standalone activity: recalculate its own progress from linked tickets
        calculateActivityProgress(id).then((prog) => {
          if (prog !== null) {
            return prisma.projectActivity.update({ where: { id }, data: { progress: prog } });
          }
        }).catch((err) => {
          console.error("[progress-rollup] standalone activity recalculation failed:", err);
        });
      }
    }

    return NextResponse.json(activity);
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
    const canDelete = await hasPermission(session.user.role, "activity.delete", session.user.customRoleId);
    if (!canDelete) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await prisma.projectActivity.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
