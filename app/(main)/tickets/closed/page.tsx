import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/permissions";
import { TicketTable } from "@/components/tickets/ticket-table";
import { TicketFilters } from "@/components/tickets/ticket-filters";
import { redirect } from "next/navigation";
import { ArchiveX } from "lucide-react";
import { Role } from "@prisma/client";

interface SearchParams {
  page?: string;
  search?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  departmentId?: string;
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

  // Base filter: all tickets with a closed status OR with a cancel reason
  const where: any = {
    OR: [
      { status: { isClosed: true } },
      { cancelReasonId: { not: null } },
    ],
  };

  if (params.search) {
    const numSearch = parseInt(params.search);
    where.AND = [
      {
        OR: [
          { title: { contains: params.search, mode: "insensitive" } },
          { description: { contains: params.search, mode: "insensitive" } },
          { requester: { name: { contains: params.search, mode: "insensitive" } } },
          { requester: { email: { contains: params.search, mode: "insensitive" } } },
          ...(!isNaN(numSearch) ? [{ ticketNumber: numSearch }] : []),
        ],
      },
    ];
  }
  if (params.statusId) where.statusId = params.statusId;
  if (params.priorityId) where.priorityId = params.priorityId;
  if (params.categoryId) where.categoryId = params.categoryId;
  if (params.departmentId) where.departmentId = params.departmentId;
  if (params.assignedAgentId) where.assignedAgentId = params.assignedAgentId;

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
      prisma.ticketStatus.findMany({
        where: { isActive: true, isClosed: true },
        orderBy: { order: "asc" },
        select: { id: true, name: true, color: true },
      }),
      prisma.ticketPriority.findMany({
        where: { isActive: true },
        orderBy: { level: "desc" },
        select: { id: true, name: true, color: true, level: true },
      }),
      prisma.ticketCategory.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      }),
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
        options={{ statuses, priorities, categories, departments, agents }}
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
