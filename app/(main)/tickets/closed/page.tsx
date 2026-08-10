import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/permissions";
import { buildTicketListWhere } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { TicketTable } from "@/components/tickets/ticket-table";
import { TicketFilters } from "@/components/tickets/ticket-filters";
import { redirect } from "next/navigation";
import { ArchiveX } from "lucide-react";
import { Role } from "@prisma/client";
import {
  getTicketFilterOptions,
  splitFilterParam,
  reconcileTicketFilterParam,
} from "@/lib/services/ticket-filter-options-service";

/** Same purpose as app/(main)/tickets/page.tsx's own helper — see there for the full rationale. */
function buildClosedTicketsUrlWithCorrections(
  params: SearchParams,
  corrections: Partial<Record<"statusId" | "priorityId" | "categoryId", string | null>>
): string {
  const merged = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) merged.set(key, value);
  }
  for (const [key, value] of Object.entries(corrections)) {
    if (value) merged.set(key, value);
    else merged.delete(key);
  }
  merged.set("page", "1");
  return `/tickets/closed?${merged.toString()}`;
}

interface SearchParams {
  page?: string;
  search?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  departmentId?: string;
  subDepartmentId?: string;
  assignedAgentId?: string;
  sortBy?: string;
  sortDir?: string;
}

export default async function ClosedTicketsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  if (!isAdmin(session.user.role)) redirect("/dashboard");

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

  // Admin's default is now their active workspace too (Phase 2B decision:
  // keep department-specific selection rather than an unscoped "all
  // departments" default — an explicit all-departments admin mode is
  // deferred). An explicit ?departmentId= still overrides for this request.
  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const effectiveDepartmentId =
    params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  if (!effectiveDepartmentId && !activeWorkspace.isAllSelected) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  const scope = await buildTicketListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) redirect("/dashboard");

  // Same workspace-scoped options + reconciliation pattern as
  // app/(main)/tickets/page.tsx — this list's Status options are further
  // narrowed to isClosed:true statuses only, matching what this page shows.
  const filterOptions = await getTicketFilterOptions(effectiveDepartmentId, session.user.id, session.user.role, {
    statusWhere: { isClosed: true },
  });
  const [reconciledStatusId, reconciledPriorityId, reconciledCategoryId] = await Promise.all([
    reconcileTicketFilterParam("status", params.statusId, filterOptions.statuses),
    reconcileTicketFilterParam("priority", params.priorityId, filterOptions.priorities),
    reconcileTicketFilterParam("category", params.categoryId, filterOptions.categories),
  ]);
  const corrections: Partial<Record<"statusId" | "priorityId" | "categoryId", string | null>> = {};
  if (reconciledStatusId !== (params.statusId ?? null)) corrections.statusId = reconciledStatusId;
  if (reconciledPriorityId !== (params.priorityId ?? null)) corrections.priorityId = reconciledPriorityId;
  if (reconciledCategoryId !== (params.categoryId ?? null)) corrections.categoryId = reconciledCategoryId;
  if (Object.keys(corrections).length > 0) {
    redirect(buildClosedTicketsUrlWithCorrections(params, corrections));
  }

  // Base filter: all tickets with a closed status OR with a cancel reason
  const andConditions: any[] = [
    scope,
    { OR: [{ status: { isClosed: true } }, { cancelReasonId: { not: null } }] },
  ];

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
  if (params.subDepartmentId) andConditions.push({ subDepartmentId: params.subDepartmentId });
  if (params.statusId) andConditions.push({ statusId: { in: splitFilterParam(params.statusId) } });
  if (params.priorityId) andConditions.push({ priorityId: { in: splitFilterParam(params.priorityId) } });
  if (params.categoryId) andConditions.push({ categoryId: { in: splitFilterParam(params.categoryId) } });
  if (params.assignedAgentId) andConditions.push({ assignedAgentId: params.assignedAgentId });

  const where: any = { AND: andConditions };

  const [tickets, total, departments, agents] = await Promise.all([
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
    prisma.department.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.user.findMany({
      where: { role: { in: [Role.IT_AGENT, Role.ADMIN] }, isActive: true },
      select: { id: true, name: true, email: true, image: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <ArchiveX className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Closed Tickets</h1>
          <p className="text-muted-foreground mt-0.5">
            All resolved, closed, and cancelled tickets
          </p>
        </div>
      </div>

      <TicketFilters
        options={{ ...filterOptions, departments, agents }}
      />

      <TicketTable
        tickets={tickets as any}
        total={total}
        page={page}
        totalPages={Math.ceil(total / limit)}
        showRequester={true}
      />
    </div>
  );
}
