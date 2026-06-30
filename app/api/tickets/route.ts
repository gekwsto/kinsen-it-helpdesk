import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth, canViewAllTickets, hasPermission } from "@/lib/permissions";
import { createTicketSchema } from "@/lib/validations";

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

    let where: any = {};

    if (!canViewAllTickets(session.user.role) || myOnly) {
      where.requesterId = session.user.id;
    }

    if (search) {
      const numSearch = parseInt(search);
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { requester: { name: { contains: search, mode: "insensitive" } } },
        { requester: { email: { contains: search, mode: "insensitive" } } },
        ...(!isNaN(numSearch) ? [{ ticketNumber: numSearch }] : []),
      ];
    }
    if (statusId) where.statusId = statusId;
    if (priorityId) where.priorityId = priorityId;
    if (categoryId) where.categoryId = categoryId;
    if (departmentId) where.departmentId = departmentId;
    if (source) where.source = source;
    if (unassigned) {
      where.assignedAgentId = null;
    } else if (assignedAgentId) {
      where.assignedAgentId = assignedAgentId;
    }
    if (createdAfter || createdBefore) {
      where.createdAt = {
        ...(createdAfter ? { gte: new Date(createdAfter) } : {}),
        ...(createdBefore ? { lte: new Date(createdBefore) } : {}),
      };
    }
    if (projectId) where.projectId = projectId;
    if (activityId) where.activityId = activityId;

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
        departmentId: data.departmentId,
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
