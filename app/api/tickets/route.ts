import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, hasPermission } from "@/lib/permissions";
import {
  buildTicketListWhere,
  resolveDepartmentForCreate,
  departmentDenialMessage,
  departmentDenialStatus,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { createTicketSchema } from "@/lib/validations";
import { Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();

    const canView = await hasPermission(session.user.role, "ticket.view", session.user.customRoleId);
    if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = new URL(req.url);

    const page = parseInt(searchParams.get("page") ?? "1");
    const limit = parseInt(searchParams.get("limit") ?? "20");
    const search = searchParams.get("search") ?? "";
    const statusId = searchParams.get("statusId");
    const priorityId = searchParams.get("priorityId");
    const categoryId = searchParams.get("categoryId");
    const assignedAgentId = searchParams.get("assignedAgentId");
    const departmentId = searchParams.get("departmentId");
    const source = searchParams.get("source"); // WEB | EMAIL
    const createdAfter = searchParams.get("createdAfter");
    const createdBefore = searchParams.get("createdBefore");
    const sortBy = searchParams.get("sortBy") ?? "createdAt"; // createdAt | updatedAt | priority | status
    const sortDir = (searchParams.get("sortDir") ?? "desc") as "asc" | "desc";
    const unassigned = searchParams.get("unassigned") === "true";
    const myOnly = searchParams.get("myOnly") === "true";
    const projectId = searchParams.get("projectId");
    const activityId = searchParams.get("activityId");

    const skip = (page - 1) * limit;

    // Department-scoped visibility — never trust a client-supplied
    // departmentId; buildTicketListWhere validates it against real
    // membership, or unions the caller's accessible departments if omitted.
    // Every other filter below is AND-ed alongside it (not merged into the
    // same object) so it can never accidentally clobber the scope's own OR
    // clause (own-tickets-only vs full department view).
    const scope = await buildTicketListWhere(session.user.id, session.user.role, departmentId);
    if ("denied" in scope) {
      return NextResponse.json({ error: "You don't have access to this department" }, { status: 403 });
    }

    const andConditions: any[] = [scope];
    if (myOnly) andConditions.push({ requesterId: session.user.id });

    if (search) {
      const numSearch = parseInt(search);
      andConditions.push({
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
          { requester: { name: { contains: search, mode: "insensitive" } } },
          { requester: { email: { contains: search, mode: "insensitive" } } },
          ...(!isNaN(numSearch) ? [{ ticketNumber: numSearch }] : []),
        ],
      });
    }
    if (statusId) andConditions.push({ statusId });
    if (priorityId) andConditions.push({ priorityId });
    if (categoryId) andConditions.push({ categoryId });
    if (source) andConditions.push({ source });
    if (unassigned) {
      andConditions.push({ assignedAgentId: null });
    } else if (assignedAgentId) {
      andConditions.push({ assignedAgentId });
    }
    if (createdAfter || createdBefore) {
      andConditions.push({
        createdAt: {
          ...(createdAfter ? { gte: new Date(createdAfter) } : {}),
          ...(createdBefore ? { lte: new Date(createdBefore) } : {}),
        },
      });
    }
    if (projectId) andConditions.push({ projectId });
    if (activityId) andConditions.push({ activityId });

    const where: any = { AND: andConditions };

    const orderBy: any =
      sortBy === "priority"
        ? { priority: { level: sortDir } }
        : sortBy === "status"
        ? { status: { order: sortDir } }
        : { [sortBy]: sortDir };

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          requester: { select: { id: true, name: true, email: true, image: true } },
          assignedAgent: { select: { id: true, name: true, email: true, image: true } },
          status: { select: { id: true, name: true, color: true } },
          priority: { select: { id: true, name: true, color: true, level: true } },
          category: { select: { id: true, name: true, color: true } },
          department: { select: { id: true, name: true } },
          _count: { select: { messages: true, attachments: true } },
        },
      }),
      prisma.ticket.count({ where }),
    ]);

    return NextResponse.json({
      tickets,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth();

    const canCreate = await hasPermission(session.user.role, "ticket.create", session.user.customRoleId);
    if (!canCreate) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json();
    const data = createTicketSchema.parse(body);

    // Only administrators can link a ticket to a project or activity
    if ((data.projectId || data.activityId) && session.user.role !== Role.ADMIN) {
      return NextResponse.json(
        { error: "Only administrators can link tickets to projects or activities" },
        { status: 403 }
      );
    }

    // A ticket attached to a project must live in that project's department
    // — inherit it if the caller didn't specify one, reject a mismatch if
    // they did. Fetched before department resolution so resolveDepartmentForCreate
    // validates the department the ticket will actually end up in.
    let effectiveRequestedDepartmentId = data.departmentId;
    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
        select: { departmentId: true },
      });
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      if (data.departmentId && project.departmentId && data.departmentId !== project.departmentId) {
        return NextResponse.json(
          { error: "A ticket cannot be attached to a project from a different department" },
          { status: 400 }
        );
      }
      effectiveRequestedDepartmentId = data.departmentId ?? project.departmentId ?? undefined;
    }

    // Still nothing explicit (no body departmentId, no linked project) —
    // fall back to the caller's active workspace (Phase 2B) instead of
    // resolveDepartmentForCreate's own primary/sole-membership fallback,
    // so creation respects a workspace the user explicitly switched to.
    if (!effectiveRequestedDepartmentId) {
      const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
      effectiveRequestedDepartmentId = activeWorkspace.departmentId ?? undefined;
    }

    const deptResolution = await resolveDepartmentForCreate(
      session.user.id,
      session.user.role,
      effectiveRequestedDepartmentId,
      "ticket.create"
    );
    if ("denied" in deptResolution) {
      return NextResponse.json(
        { error: departmentDenialMessage(deptResolution.denied) },
        { status: departmentDenialStatus(deptResolution.denied) }
      );
    }

    const defaultStatus = await prisma.ticketStatus.findFirst({
      where: { isDefault: true },
    });

    if (!defaultStatus) {
      return NextResponse.json(
        { error: "No default status configured" },
        { status: 500 }
      );
    }

    const ticket = await prisma.ticket.create({
      data: {
        title: data.title,
        description: data.description,
        source: "WEB",
        requesterId: session.user.id,
        statusId: defaultStatus.id,
        categoryId: data.categoryId,
        priorityId: data.priorityId,
        departmentId: deptResolution.departmentId,
        projectId: data.projectId,
        activityId: data.activityId,
      },
      include: {
        status: true,
        priority: true,
        category: true,
        requester: { select: { id: true, name: true, email: true } },
      },
    });

    // Record creation history
    await prisma.ticketHistory.create({
      data: {
        ticketId: ticket.id,
        changedById: session.user.id,
        type: "CREATED",
        description: "Ticket created",
        newValue: "WEB",
      },
    });

    // Initial message (description as first message)
    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: session.user.id,
        body: data.description,
        direction: "INBOUND",
      },
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
