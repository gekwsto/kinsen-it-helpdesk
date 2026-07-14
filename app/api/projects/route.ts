import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import {
  buildProjectListWhere,
  resolveDepartmentForCreate,
  departmentDenialMessage,
  departmentDenialStatus,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { createProjectSchema } from "@/lib/validations";
import { Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();
    const { searchParams } = new URL(req.url);

    const page = parseInt(searchParams.get("page") ?? "1");
    const limit = parseInt(searchParams.get("limit") ?? "20");
    const search = searchParams.get("search") ?? "";
    const status = searchParams.get("status");
    const departmentId = searchParams.get("departmentId");

    const skip = (page - 1) * limit;

    const scope = await buildProjectListWhere(session.user.id, session.user.role, departmentId);
    if ("denied" in scope) {
      return NextResponse.json({ error: "You don't have access to this department" }, { status: 403 });
    }

    const andConditions: any[] = [scope];
    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ],
      });
    }
    if (status) andConditions.push({ status });

    const where: any = { AND: andConditions };

    const [projects, total] = await Promise.all([
      prisma.project.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          owner: { select: { id: true, name: true, email: true, image: true } },
          department: { select: { id: true, name: true } },
          businessUnit: { select: { id: true, name: true } },
          members: { select: { id: true, name: true, image: true } },
          _count: { select: { activities: true } },
        },
      }),
      prisma.project.count({ where }),
    ]);

    return NextResponse.json({
      projects,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const body = await req.json();
    const data = createProjectSchema.parse(body);

    // No explicit departmentId in the body — fall back to the caller's
    // active workspace (Phase 2B) before resolveDepartmentForCreate's own
    // primary/sole-membership fallback.
    let effectiveRequestedDepartmentId = data.departmentId;
    if (!effectiveRequestedDepartmentId) {
      const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
      effectiveRequestedDepartmentId = activeWorkspace.departmentId ?? undefined;
    }

    const deptResolution = await resolveDepartmentForCreate(
      session.user.id,
      session.user.role,
      effectiveRequestedDepartmentId,
      "project.create"
    );
    if ("denied" in deptResolution) {
      return NextResponse.json(
        { error: departmentDenialMessage(deptResolution.denied) },
        { status: departmentDenialStatus(deptResolution.denied) }
      );
    }

    const { memberIds, startDate, endDate, departmentId: _ignoredDepartmentId, ...rest } = data;

    // Validate that all assigned members are ADMIN users
    if (memberIds.length > 0) {
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

    const project = await prisma.project.create({
      data: {
        ...rest,
        departmentId: deptResolution.departmentId,
        ownerId: session.user.id,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        members: memberIds.length
          ? { connect: memberIds.map((id) => ({ id })) }
          : undefined,
      },
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        department: { select: { id: true, name: true } },
        members: { select: { id: true, name: true, image: true } },
        _count: { select: { activities: true } },
      },
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
