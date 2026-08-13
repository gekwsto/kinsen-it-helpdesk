import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/permissions";
import {
  buildTicketListWhere,
  resolveDepartmentForCreate,
  departmentDenialMessage,
  departmentDenialStatus,
  resolveDefaultStatusId,
  validateTicketProjectActivityLink,
  validateTicketConfigOwnership,
  getNavVisibilityFlags,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { validateSubDepartmentInDepartment } from "@/lib/services/sub-department-service";
import { createTicketAtomic } from "@/lib/services/ticket-creation-service";
import { createTicketSchema } from "@/lib/validations";
import { notifyRequesterCreated } from "@/lib/ticket-notification-service";
import { Role } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth();

    // Same union app/(main)/tickets/page.tsx and the sidebar use — a raw
    // hasPermission(...) call only sees GLOBAL grants and would 403 a user
    // whose ticket.view comes solely from a department built-in/custom role,
    // even though buildTicketListWhere below already scopes correctly.
    const canView = (
      await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId)
    ).canViewTickets;
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
    const subDepartmentId = searchParams.get("subDepartmentId");
    const source = searchParams.get("source"); // WEB | EMAIL | API
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
    // A narrowing filter within whatever department scope already resolved
    // above — never a second access-control dimension (see Decision §0.5).
    if (subDepartmentId) andConditions.push({ subDepartmentId });

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
    // — inherit it if the caller didn't specify one. The actual scope/pair
    // validation (project exists, belongs to this department, activity
    // exists/matches) happens once below via validateTicketProjectActivityLink,
    // after the department is fully resolved.
    let effectiveRequestedDepartmentId = data.departmentId;
    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
        select: { departmentId: true },
      });
      if (!project) {
        return NextResponse.json({ error: "Project not found", code: "project_not_found" }, { status: 404 });
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

    // The sole authoritative ticket.create check — department-scoped OR the
    // ADMIN/DIRECTOR bypass (canViewAllDepartments), exactly like
    // POST /api/projects and POST /api/activities use "project.create"/
    // "activity.create" here. A prior standalone `hasPermission(role,
    // "ticket.create", customRoleId)` pre-check used to gate this route
    // first — GLOBAL-only, so it wrongly 403'd a user whose ticket.create
    // came solely from a department built-in/custom role (e.g. the built-in
    // AGENT_ASSIGNEE department role) before ever reaching this correct,
    // department-aware check. Removed rather than fixed-in-place, since
    // resolveDepartmentForCreate already IS the correct, single check.
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

    if (data.projectId || data.activityId) {
      const linkValidation = await validateTicketProjectActivityLink(
        deptResolution.departmentId,
        data.projectId ?? null,
        data.activityId ?? null
      );
      if (!linkValidation.ok) {
        return NextResponse.json({ error: linkValidation.message, code: linkValidation.code }, { status: linkValidation.code === "project_not_found" || linkValidation.code === "activity_not_found" ? 404 : 400 });
      }
    }

    if (data.subDepartmentId) {
      const valid = await validateSubDepartmentInDepartment(data.subDepartmentId, deptResolution.departmentId);
      if (!valid) {
        return NextResponse.json(
          { error: "The selected sub-department does not belong to this ticket's department.", code: "subdepartment_department_mismatch" },
          { status: 400 }
        );
      }
    }

    // Department-specific default status wins if the target department has
    // one configured; otherwise the global default — see
    // resolveDefaultStatusId in department-scope-service.ts.
    const defaultStatusId = await resolveDefaultStatusId(deptResolution.departmentId);

    if (!defaultStatusId) {
      return NextResponse.json(
        { error: "No default status configured" },
        { status: 500 }
      );
    }

    // categoryId/priorityId ARE accepted directly from the client (statusId
    // above never is — it's always server-resolved) — never trust that a
    // submitted id actually belongs to this department without checking:
    // TicketCategory/TicketPriority are department-owned config tables, and
    // accepting a foreign department's row here is exactly how a real
    // cross-department data-integrity bug was previously introduced (see
    // scripts/repair-ticket-config-department-mismatch.ts).
    if (data.categoryId || data.priorityId) {
      const ownership = await validateTicketConfigOwnership(deptResolution.departmentId, {
        categoryId: data.categoryId,
        priorityId: data.priorityId,
      });
      if (!ownership.ok) {
        return NextResponse.json({ error: ownership.message, code: `${ownership.field}_department_mismatch` }, { status: 400 });
      }
    }

    const ticket = await createTicketAtomic(
      {
        title: data.title,
        description: data.description,
        source: "WEB",
        requesterId: session.user.id,
        statusId: defaultStatusId,
        categoryId: data.categoryId,
        priorityId: data.priorityId,
        departmentId: deptResolution.departmentId,
        subDepartmentId: data.subDepartmentId,
        projectId: data.projectId,
        activityId: data.activityId,
        // The requester is always the creator, so both share flags are
        // accepted unconditionally (owner bypass) — still defensively
        // coerced server-side per "shareWithSubDepartment requires a
        // subDepartmentId", not just relying on the UI disabling the checkbox.
        shareWithDepartment: data.shareWithDepartment,
        shareWithSubDepartment: data.subDepartmentId ? data.shareWithSubDepartment : false,
      },
      { changedById: session.user.id, description: "Ticket created" }
    );

    // TEMPORARY development-only diagnostic tracing — see the matching
    // notifyDiag() calls in lib/ticket-notification-service.ts.
    if (process.env.NODE_ENV !== "production") {
      console.log("[notify-diag] POST /api/tickets:ticket-created", JSON.stringify({ ticketId: ticket.id, ticketNumber: ticket.ticketNumber }));
    }

    // Deferred, not blocking the response: the ticket itself is already
    // fully committed above, so a slow/failed Graph call must never delay
    // or fail this request. after() (Next.js 15) keeps this work alive
    // until it completes even though the response has already been sent —
    // unlike a bare fire-and-forget call, nothing here can be silently
    // dropped if the platform would otherwise consider the request
    // "finished" the moment the response streams out.
    if (process.env.NODE_ENV !== "production") {
      console.log("[notify-diag] POST /api/tickets:before-after-schedule", JSON.stringify({ ticketId: ticket.id }));
    }
    after(() => {
      if (process.env.NODE_ENV !== "production") {
        console.log("[notify-diag] POST /api/tickets:after-callback-start", JSON.stringify({ ticketId: ticket.id }));
      }
      return notifyRequesterCreated({ ticketId: ticket.id });
    });

    return NextResponse.json(ticket, { status: 201 });
  } catch (error: any) {
    if (error.name === "ZodError") {
      return NextResponse.json({ error: error.errors }, { status: 422 });
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
