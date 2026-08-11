import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { buildCreatedByMeWhere, getAccessibleDepartmentSummaries } from "@/lib/services/department-scope-service";
import { TicketTable } from "@/components/tickets/ticket-table";
import { TicketFilters } from "@/components/tickets/ticket-filters";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Ticket } from "lucide-react";
import { redirect } from "next/navigation";
import { getTicketFilterOptions, splitFilterParam } from "@/lib/services/ticket-filter-options-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  departmentId?: string;
  subDepartmentId?: string;
  source?: string;
  createdAfter?: string;
  createdBefore?: string;
  sortBy?: string;
  sortDir?: string;
}

/** Preserves every param except `page` — same pattern as app/(main)/projects/page.tsx's own buildCanonicalUrl. */
function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/tickets/created-by-me?${canonical.toString()}`;
}

/**
 * Tickets the current user requested/submitted themselves — split out of the
 * old "My Tickets" (which conflated created vs. assigned) alongside
 * /tickets/assigned-to-me. No department-membership gating: seeing your own
 * tickets needs no permission beyond ticket.view (see
 * buildCreatedByMeWhere in lib/services/department-scope-service.ts) — the
 * optional department filter below just narrows an already-personal result
 * set further, it never grants visibility into anyone else's tickets.
 */
export default async function CreatedByMeTicketsPage({
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

  const params = await searchParams;
  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);
  const skip = (requestedPage - 1) * pageSize;

  const sortBy = params.sortBy ?? "createdAt";
  const sortDir = (params.sortDir ?? "desc") as "asc" | "desc";
  const primarySort =
    sortBy === "priority"
      ? { priority: { level: sortDir } }
      : sortBy === "status"
      ? { status: { order: sortDir } }
      : { [sortBy]: sortDir };
  // `id` as a secondary sort key guarantees fully deterministic pagination
  // — see app/(main)/tickets/page.tsx's identical comment.
  const orderBy: any = [primarySort, { id: "asc" }];

  const andConditions: any[] = [buildCreatedByMeWhere(session.user.id, params.departmentId)];

  if (params.search) {
    const numSearch = parseInt(params.search);
    andConditions.push({
      OR: [
        { title: { contains: params.search, mode: "insensitive" } },
        { description: { contains: params.search, mode: "insensitive" } },
        ...(!isNaN(numSearch) ? [{ ticketNumber: numSearch }] : []),
      ],
    });
  }
  if (params.subDepartmentId) andConditions.push({ subDepartmentId: params.subDepartmentId });
  if (params.statusId) andConditions.push({ statusId: { in: splitFilterParam(params.statusId) } });
  if (params.priorityId) andConditions.push({ priorityId: { in: splitFilterParam(params.priorityId) } });
  if (params.categoryId) andConditions.push({ categoryId: { in: splitFilterParam(params.categoryId) } });
  if (params.source) andConditions.push({ source: params.source });
  if (params.createdAfter || params.createdBefore) {
    andConditions.push({
      createdAt: {
        ...(params.createdAfter ? { gte: new Date(params.createdAfter) } : {}),
        ...(params.createdBefore ? { lte: new Date(params.createdBefore) } : {}),
      },
    });
  }

  const where: any = { AND: andConditions };

  // No active-workspace concept on this page (an explicit ?departmentId=
  // just narrows an already-personal result set — see buildCreatedByMeWhere
  // above) — filter options are scoped the same way: that one department if
  // given, else the full set the caller may view tickets in.
  const [tickets, total, filterOptions, departments] = await Promise.all([
    prisma.ticket.findMany({
      where,
      skip,
      take: pageSize,
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
    getTicketFilterOptions(params.departmentId, session.user.id, role),
    getAccessibleDepartmentSummaries(session.user.id, role, "ticket.view"),
  ]);

  const pagination = computePagination(total, requestedPage, pageSize);
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Created by Me</h1>
          <p className="text-muted-foreground mt-1">Tickets you&apos;ve submitted</p>
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

      <TicketFilters options={{ ...filterOptions, departments, agents: [] }} />

      <TicketTable
        tickets={tickets as any}
        pagination={pagination}
        showRequester={false}
        emptyMessage="You have not created any tickets yet."
      />
    </div>
  );
}
