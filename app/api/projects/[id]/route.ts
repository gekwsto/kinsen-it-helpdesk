import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireAdmin, hasPermission } from "@/lib/permissions";
import { updateProjectSchema } from "@/lib/validations";
import { Role } from "@prisma/client";

const PROJECT_INCLUDE = {
  owner: { select: { id: true, name: true, email: true, image: true } },
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
  members: { select: { id: true, name: true, email: true, image: true } },
  activities: {
    orderBy: { createdAt: "desc" as const },
    include: {
      assignedUser: { select: { id: true, name: true, image: true } },
    },
  },
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await requireAuth();
    const project = await prisma.project.findUnique({
      where: { id },
      include: PROJECT_INCLUDE,
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(project);
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

    const canEdit = await hasPermission(session.user.role, "project.edit", session.user.customRoleId);
    if (!canEdit) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const data = updateProjectSchema.parse(body);
    const { memberIds, startDate, endDate, ...rest } = data;

    // Validate that all assigned members are ADMIN users
    if (memberIds && memberIds.length > 0) {
      const adminCount = await prisma.user.count({
        where: { id: { in: memberIds }, role: Role.ADMIN },
      });
      if (adminCount !== memberIds.length) {
        return NextResponse.json(
          { error: "Project members must be administrators" },
          { status: 400 }
        );
      }
    }

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...rest,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        members: memberIds
          ? { set: memberIds.map((memberId) => ({ id: memberId })) }
          : undefined,
      },
      include: PROJECT_INCLUDE,
    });

    return NextResponse.json(project);
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
    await requireAdmin();

    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Safe cascade behaviour (no migration needed):
    //   Ticket.projectId        → nullable, DB SetNull default
    //   ProjectActivity.projectId → onDelete: SetNull (explicit in schema)
    //   _ProjectMembers join rows → DB CASCADE (implicit M2M)
    //   _GoalProjects join rows   → DB CASCADE (implicit M2M)
    await prisma.project.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (error: any) {
    if (error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
