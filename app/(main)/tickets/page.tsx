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
import { parseTicketStatusGroup } from "@/lib/services/ticket-status-groups";
import {
  getTicketFilterOptions,
  splitFilterParam,
  reconcileTicketFilterParam,
} from "@/lib/services/ticket-filter-options-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";
import { Role } from "@prisma/client";

/**
 * Rebuilds the current URL with one or more statusId/priorityId/categoryId
 * values corrected (or removed, for `null`) — used only when a previously
 * selected filter no longer applies after the active workspace changed (see
 * reconcileTicketFilterParam). Preserves every other param (search, sort,
 * other compatible filters) and always resets to page 1, since the filtered
 * result set has genuinely changed.
 */
function buildTicketsUrlWithCorrections(
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
  return `/tickets?${merged.toString()}`;
}

/**
 * Preserves every param except `status` (dropped — its destination, /tickets/closed,
 * has its own scope and doesn't need it) and `page` (reset — a different page's
 * result set). Used only for the ?status=closed -> /tickets/closed redirect below.
 */
function buildClosedRedirectUrl(params: SearchParams): string {
  const merged = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page" || key === "status") continue;
    if (typeof value === "string" && value) merged.set(key, value);
  }
  const qs = merged.toString();
  return qs ? `/tickets/closed?${qs}` : "/tickets/closed";
}

/**
 * Canonical-page redirect target when the requested `?page=` is out of
 * range (e.g. a bookmarked page past the end, or the last row on the last
 * page was just deleted/reassigned out of scope) — preserves every other
 * param (including pageSize) exactly, same pattern as
 * app/(main)/projects/page.tsx's own buildCanonicalUrl.
 */
function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/tickets?${canonical.toString()}`;
}

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  /**
   * Legacy/deep-link-only status GROUP — no longer user-selectable in the UI
   * (the old left-most "Open" dropdown was removed; see
   * components/tickets/ticket-filters.tsx). Only two values still change
   * behavior here: "all" (the Dashboard's "Total Tickets" KPI card — lifts
   * the default non-closed scope so closed/cancelled-status tickets are
   * included too) and "closed" (the Dashboard's "Closed Tickets" KPI card —
   * redirects to the dedicated /tickets/closed page, the actual canonical
   * home for closed tickets). Any other value (including the former
   * "in_progress" name-heuristic group, which used to silently AND-conflict
   * with an explicitly selected statusId — see the redesign notes on the
   * base scope below) is treated the same as absent: the implicit
   * non-closed default. statusId below is the real, precise, per-department
   * filter and is unaffected by this legacy param either way.
   */
  status?: string;
  statusId?: string;
  priorityId?: string;
  categoryId?: string;
  departmentId?: string;
  subDepartmentId?: string;
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
    redirect("/tickets/created-by-me");
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
  // even when two tickets share the exact same primary sort value (e.g.
  // identical createdAt from bulk-seeded/imported data) — same pattern as
  // app/(main)/projects/page.tsx and app/(main)/activities/page.tsx.
  const orderBy: any = [primarySort, { id: "asc" }];

  // Active workspace is the default scope now (Phase 2B) — an explicit
  // ?departmentId= still wins as an "explicit scoped view," but omitting it
  // no longer falls back to a union of every accessible department.
  const activeWorkspace = await getActiveWorkspace(session.user.id, role);
  const effectiveDepartmentId =
    params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  if (!effectiveDepartmentId && !activeWorkspace.isAllSelected) {
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

  // The legacy status-GROUP deep-link (see the SearchParams doc comment
  // above) — "closed" now belongs exclusively to the dedicated Closed
  // Tickets page. Redirecting here (rather than silently re-showing an
  // empty/wrong scope) is what actually eliminates the class of bug this
  // page had: two INDEPENDENTLY computed "which statuses are in scope"
  // answers (a coarse isClosed/name heuristic AND a precise statusId) that
  // could silently disagree and AND together into zero rows. There is now
  // exactly one scope decision on this page (isAllStatusesMode below), and
  // both the Status dropdown's own option list and the base Prisma
  // condition are derived from that SAME single value — never two
  // independently-drifting conditions that can contradict each other.
  if (parseTicketStatusGroup(params.status) === "closed") {
    redirect(buildClosedRedirectUrl(params));
  }
  // "all" (the Dashboard's "Total Tickets" KPI card) lifts the normal
  // non-closed default so closed/cancelled-status tickets are included too
  // — every other value (absent, "open", or the retired "in_progress"
  // name-heuristic) means the normal implicit default scope.
  const isAllStatusesMode = parseTicketStatusGroup(params.status) === "all";

  // Status/Priority/Category options for THIS workspace scope (or the
  // authorized union for "All Workspaces") — fetched once, reused both to
  // reconcile a possibly-now-invalid selected filter (below) and to render
  // the filter dropdowns further down, so switching workspaces never
  // requires a second round-trip to pick up the new option set. The Status
  // options are themselves scoped to isClosed:false (unless isAllStatusesMode
  // lifts that) — so whatever the user picks from the dropdown can NEVER
  // contradict the base scope condition below; the two are constructed from
  // the same source, not verified to agree after the fact.
  const filterOptions = await getTicketFilterOptions(
    effectiveDepartmentId,
    session.user.id,
    role,
    isAllStatusesMode ? {} : { statusWhere: { isClosed: false } }
  );

  // If the active workspace changed since statusId/priorityId/categoryId
  // were selected, a previously valid choice may no longer exist in this
  // scope. reconcileTicketFilterParam carries the selection over (by name)
  // if an equivalent option still exists, or reports null if it doesn't —
  // never leaving a stale/invalid id silently active. A one-time redirect
  // (not a client-side patch) keeps the URL itself the source of truth, so
  // Back/Forward and bookmarks stay correct.
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
    redirect(buildTicketsUrlWithCorrections(params, corrections));
  }

  // Base filter: never-cancelled (unconditional, matching this page's
  // original behavior), plus the same non-closed default the Status
  // dropdown's own options are scoped to above — unless isAllStatusesMode
  // lifted it. Because both this condition and the dropdown's option list
  // are derived from the identical `isAllStatusesMode` value, a statusId the
  // user actually selected can never be outside this scope: it's always
  // implied compatible by construction, not just implied likely.
  const andConditions: any[] = [scope, { cancelReasonId: null }];
  if (!isAllStatusesMode) andConditions.push({ status: { isClosed: false } });

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
  if (params.subDepartmentId) andConditions.push({ subDepartmentId: params.subDepartmentId });
  // statusId/priorityId/categoryId may carry several comma-joined real ids
  // when the selected option came from a grouped "All Workspaces" choice
  // (the same name configured in more than one authorized department) —
  // always a set of real FK ids, never a name-based match.
  if (params.statusId) andConditions.push({ statusId: { in: splitFilterParam(params.statusId) } });
  if (params.priorityId) andConditions.push({ priorityId: { in: splitFilterParam(params.priorityId) } });
  if (params.categoryId) andConditions.push({ categoryId: { in: splitFilterParam(params.categoryId) } });
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
        departmentChangedBy: { select: { id: true, name: true, email: true } },
        _count: { select: { messages: true, attachments: true } },
      },
    }),
    prisma.ticket.count({ where }),
    // Only departments the caller can actually filter to — never one that
    // would just 403 if picked.
    getAccessibleDepartmentSummaries(session.user.id, role, "ticket.view"),
    prisma.user.findMany({ where: { role: { in: [Role.IT_AGENT, Role.ADMIN] }, isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const pagination = computePagination(total, requestedPage, pageSize);
  // The requested page doesn't exist for this result set (a bookmarked/typed
  // page past the end, or the last row on the last page was just
  // deleted/reassigned out of scope) — canonicalize to the real last valid
  // page rather than rendering the empty skip, same pattern as
  // app/(main)/projects/page.tsx / app/(main)/admin/users/page.tsx.
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

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
        options={{ ...filterOptions, departments, agents }}
        isAllTickets
        currentUserId={session.user.id}
      />

      <TicketTable
        tickets={tickets as any}
        pagination={pagination}
        showRequester
      />
    </div>
  );
}
