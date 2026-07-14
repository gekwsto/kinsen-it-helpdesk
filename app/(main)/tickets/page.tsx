import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import {
  buildTicketListWhere,
  hasAnyFullTicketView,
  getAccessibleDepartmentSummaries,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { TicketTable } from "@/components/tickets/ticket-table";
import { TicketFilters } from "@/components/tickets/ticket-filters";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Ticket } from "lucide-react";
import { redirect } from "next/navigation";
import { Role } from "@prisma/client";

interface SearchParams {
  page?: string;
  search?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  departmentId?: string;
  assignedAgentId?: string;
  source?: string;
  createdAfter?: string;
  createdBefore?: string;
  sortBy?: string;
  sortDir?: string;
  unassigned?: string;
  myOnly?: string;
}

export default async function AllTicketsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const role = session.user.role;
  const customRoleId = session.user.customRoleId;

  const [canView, canCreate] = await Promise.all([
    hasPermission(role, "ticket.view", customRoleId),
    hasPermission(role, "ticket.create", customRoleId),
  ]);

  if (!canView) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <Ticket className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">No access to tickets</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have permission to view tickets. Contact your administrator to request access.
        </p>
      </div>
    );
  }

  if (!(await hasAnyFullTicketView(session.user.id, role))) {
    redirect("/my-tickets");
  }

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1"));
  const limit = 20;
  const skip = (page - 1) * limit;

  const sortBy = params.sortBy ?? "createdAt";
  const sortDir = (params.sortDir ?? "desc") as "asc" | "desc";
  const orderBy: any =
    sortBy === "priority"
      ? { priority: { level: sortDir } }
      : sortBy === "status"
      ? { status: { order: sortDir } }
      : { [sortBy]: sortDir };

  // Active workspace is the default scope now (Phase 2B) — an explicit
  // ?departmentId= still wins as an "explicit scoped view," but omitting it
  // no longer falls back to a union of every accessible department.
  const activeWorkspace = await getActiveWorkspace(session.user.id, role);
  const effectiveDepartmentId = params.departmentId ?? activeWorkspace.departmentId;

  if (!effectiveDepartmentId) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Department-scoped visibility — validated against real membership, never
  // trusted from the URL. AND-ed alongside every other filter (not merged
  // into one object) so a search/status filter can never clobber the
  // scope's own OR clause (own-tickets-only vs full department view).
  const scope = await buildTicketListWhere(session.user.id, role, effectiveDepartmentId);
  if ("denied" in scope) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <Ticket className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground text-sm max-w-sm">You don&apos;t have access to that department.</p>
      </div>
    );
  }

  // Base filter: only open (non-closed, non-cancelled) tickets
  const andConditions: any[] = [scope, { status: { isClosed: false } }, { cancelReasonId: null }];

  if (params.myOnly === "true") {
    andConditions.push({ requesterId: session.user.id });
  }

  if (params.search) {
    const numSearch = parseInt(params.search);
    andConditions.push({
      OR: [
        { title: { contains: params.search, mode: "insensitive" } },
        { description: { contains: params.search, mode: "insensitive" } },
        { requester: { name: { contains: params.search, mode: "insensitive" } } },
        { requester: { email: { contains: params.search, mode: "insensitive" } } },
        ...(!isNaN(numSearch) ? [{ ticketNumber: numSearch }] : []),
      ],
    });
  }
  if (params.statusId) andConditions.push({ statusId: params.statusId });
  if (params.priorityId) andConditions.push({ priorityId: params.priorityId });
  if (params.categoryId) andConditions.push({ categoryId: params.categoryId });
  if (params.source) andConditions.push({ source: params.source });
  if (params.unassigned === "true") {
    andConditions.push({ assignedAgentId: null });
  } else if (params.assignedAgentId) {
    andConditions.push({ assignedAgentId: params.assignedAgentId });
  }
  if (params.createdAfter || params.createdBefore) {
    andConditions.push({
      createdAt: {
        ...(params.createdAfter ? { gte: new Date(params.createdAfter) } : {}),
        ...(params.createdBefore ? { lte: new Date(params.createdBefore) } : {}),
      },
    });
  }

  const where: any = { AND: andConditions };

  const [tickets, total, statuses, priorities, categories, departments, agents] =
    await Promise.all([
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
          project: { select: { id: true, title: true } },
          _count: { select: { messages: true, attachments: true } },
        },
      }),
      prisma.ticket.count({ where }),
      prisma.ticketStatus.findMany({ where: { isActive: true }, orderBy: { order: "asc" }, select: { id: true, name: true, color: true } }),
      prisma.ticketPriority.findMany({ where: { isActive: true }, orderBy: { level: "desc" }, select: { id: true, name: true, color: true, level: true } }),
      prisma.ticketCategory.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
      // Only departments the caller can actually filter to — never one that
      // would just 403 if picked.
      getAccessibleDepartmentSummaries(session.user.id, role, "ticket.view"),
      prisma.user.findMany({ where: { role: { in: [Role.IT_AGENT, Role.ADMIN] }, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">All Tickets</h1>
          <p className="text-muted-foreground mt-1">Manage and view all support tickets</p>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/tickets/new">
              <Plus className="h-4 w-4 mr-2" />
              New Ticket
            </Link>
          </Button>
        )}
      </div>

      <TicketFilters
        options={{ statuses, priorities, categories, departments, agents }}
        isAllTickets
        currentUserId={session.user.id}
      />

      <TicketTable
        tickets={tickets as any}
        total={total}
        page={page}
        totalPages={Math.ceil(total / limit)}
        showRequester
      />
    </div>
  );
}
