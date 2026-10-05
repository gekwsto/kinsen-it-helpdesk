import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTicketListWhere, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState } from "@/components/workspace/workspace-gate";
import { TicketTable } from "@/components/tickets/ticket-table";
import { TicketFilters } from "@/components/tickets/ticket-filters";
import { TicketListLiveRefresh } from "@/components/tickets/ticket-list-live-refresh";
import { redirect } from "next/navigation";
import { Ticket as TicketIcon } from "lucide-react";
import {
  getTicketFilterOptions,
  splitFilterParam,
  reconcileTicketFilterParam,
  getVisibleTicketAssignees,
} from "@/lib/services/ticket-filter-options-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";
import { resolveListSort } from "@/lib/list-sort";
import { TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY } from "@/lib/services/ticket-list-sort";

/** Same purpose as app/(main)/tickets/closed/page.tsx's own helper — see there for the full rationale. */
function buildOpenTicketsUrlWithCorrections(
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
  return `/tickets/open?${merged.toString()}`;
}

/** Preserves every param except `page` — used for the out-of-range canonical redirect, same pattern as app/(main)/tickets/closed/page.tsx. */
function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/tickets/open?${canonical.toString()}`;
}

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  departmentId?: string;
  subDepartmentId?: string;
  assignedAgentId?: string;
  /** Same "Only unassigned" special option app/(main)/tickets/closed/page.tsx already supports. */
  unassigned?: string;
  /** Whitelisted against TICKET_SORT_KEYS — see lib/list-sort.ts and lib/services/ticket-list-sort.ts. */
  sortBy?: string;
  sortOrder?: string;
}

/**
 * Open Tickets — the mirror image of app/(main)/tickets/closed/page.tsx,
 * same architecture throughout (workspace scoping, filters, pagination,
 * sort, realtime), with exactly one thing inverted: the base scope
 * condition.
 *
 * Canonical rule (never a status-NAME heuristic): a Ticket is "open" iff
 * its CURRENT status has `isClosed: false` AND it was never cancelled
 * (`cancelReasonId: null`) — the exact logical complement of Closed's own
 * base condition (`OR[{status.isClosed:true},{cancelReasonId:not:null}]`),
 * so a Ticket always appears in exactly one of Open/Closed, never both,
 * never neither (the cancelReasonId clause matters only for the rare case
 * where a department has no configured closed-type status at the moment a
 * Ticket is cancelled — see app/api/tickets/[id]/cancel/route.ts, which
 * only moves the Ticket to a closed status "if one exists" — without
 * excluding cancelReasonId!=null here, such a Ticket would wrongly show as
 * "Open"). This is also EXACTLY the same condition
 * app/(main)/tickets/page.tsx's own default (non-"all") scope already
 * uses — Open simply gives that existing default its own dedicated,
 * bookmarkable, correctly-labeled page, the same way Closed already has
 * one instead of requiring `?status=closed` on the main list.
 *
 * Gated on navFlags.canViewAllTickets — the SAME capability "All Tickets"
 * itself requires, never the separate (elevated) canViewClosedTickets:
 * Open is only ever a FILTERED SLICE of what All Tickets' own default view
 * already shows, not a new category of information.
 */
export default async function OpenTicketsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const openNavFlags = await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId);
  if (!openNavFlags.canViewAllTickets) redirect("/dashboard");

  const params = await searchParams;
  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);
  const skip = (requestedPage - 1) * pageSize;

  // Whitelist-only, URL-driven sort — see app/(main)/tickets/page.tsx's
  // identical comment.
  const orderBy = resolveListSort(TICKET_SORT_KEYS, TICKET_DEFAULT_ORDER_BY, params.sortBy, params.sortOrder).orderBy;

  // Same precedence rule as app/(main)/tickets/page.tsx and
  // app/(main)/tickets/closed/page.tsx (see their own doc comments for the
  // full history): an explicit ?departmentId= wins outright; absent one,
  // the list follows the active Workspace; "All Workspaces"
  // (canViewAllDepartments roles only) explicitly expands to the full
  // accessible union.
  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  const effectiveDepartmentId = params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  if (activeWorkspace.departments.length === 0) {
    return <NoWorkspaceState />;
  }

  const scope = await buildTicketListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) redirect("/dashboard");

  // Same workspace-scoped options + reconciliation pattern as
  // app/(main)/tickets/closed/page.tsx — this list's Status options are
  // further narrowed to isClosed:false statuses only, matching what this
  // page shows (never a name-based match, e.g. never excluding/including
  // by whether a status is literally called "Open").
  const filterOptions = await getTicketFilterOptions(effectiveDepartmentId, session.user.id, session.user.role, {
    statusWhere: { isClosed: false },
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
    redirect(buildOpenTicketsUrlWithCorrections(params, corrections));
  }

  // Base filter: every non-cancelled Ticket whose CURRENT status has
  // isClosed: false — see this page's own doc comment above for why both
  // conditions are needed (the exact complement of Closed's own base
  // condition).
  const andConditions: any[] = [scope, { cancelReasonId: null }, { status: { isClosed: false } }];

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

  // Snapshot BEFORE assignedAgentId/unassigned — see getVisibleTicketAssignees's
  // own doc comment for why the option list must never be derived from a
  // where-clause that already narrows to the currently selected assignee.
  const assigneeOptionsWhere = { AND: [...andConditions] };

  // Same "Only unassigned" precedence as app/(main)/tickets/closed/page.tsx.
  if (params.unassigned === "true") {
    andConditions.push({ assignedAgentId: null });
  } else if (params.assignedAgentId) {
    andConditions.push({ assignedAgentId: params.assignedAgentId });
  }

  const where: any = { AND: andConditions };

  const [tickets, total, departments, agents] = await Promise.all([
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
    prisma.department.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    getVisibleTicketAssignees(assigneeOptionsWhere),
  ]);

  const pagination = computePagination(total, requestedPage, pageSize);
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

  return (
    <div className="space-y-6">
      <TicketListLiveRefresh />
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <TicketIcon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Open Tickets</h1>
          <p className="text-muted-foreground mt-0.5">
            All tickets not yet closed or cancelled
          </p>
        </div>
      </div>

      <TicketFilters
        options={{ ...filterOptions, departments, agents }}
        showAssigneeFilter
      />

      <TicketTable
        tickets={tickets as any}
        pagination={pagination}
        showRequester={true}
      />
    </div>
  );
}
