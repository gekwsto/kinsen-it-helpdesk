import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getAccessibleDepartmentSummaries, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { ViewToggle } from "@/components/ui/view-toggle";
import { ProjectList } from "@/components/projects/project-list";
import { ProjectFilters } from "@/components/projects/project-filters";
import { ProjectPaginationBar } from "@/components/projects/project-pagination-bar";
import { ProjectListLiveRefresh } from "@/components/projects/project-list-live-refresh";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus, FolderKanban } from "lucide-react";
import { getProjectTerminalConfigsForDepartments, resolveProjectTerminal } from "@/lib/status-terminal";
import { isProjectOverdue } from "@/lib/overdue";
import {
  buildProjectListQuery,
  getProjectOwnerOptions,
  getProjectMemberOptions,
  type ProjectListFilterParams,
} from "@/lib/services/project-query-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";
import { ExportProjectsButton } from "@/components/projects/export-projects-button";

// Pagination/view-only params — every FILTER/sort param (search, status,
// origin, date ranges, etc.) comes from ProjectListFilterParams, the SAME
// shape lib/services/project-query-service.ts's buildProjectListQuery
// accepts and the Excel export route (app/api/projects/export/route.ts)
// re-reads from its own request — never duplicated here.
interface SearchParams extends ProjectListFilterParams {
  page?: string;
  pageSize?: string;
  view?: string;
  departmentId?: string;
}

function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/projects?${canonical.toString()}`;
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const params = await searchParams;

  // Same union canFlags.canViewProjects computes for the sidebar
  // (cache()-wrapped, so this reuses app/(main)/layout.tsx's already-computed
  // result within the same render) — a raw hasPermission(...) call only sees
  // GLOBAL grants and would wrongly deny a user whose project.view comes
  // solely from a department built-in/custom role.
  const projectsNavFlags = await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId);
  const canView = projectsNavFlags.canViewProjects;
  if (!canView) {
    redirect("/dashboard");
  }
  // Never derived from canView above — VIEW does not imply CREATE. This
  // page's own "New Project" button (below) previously had NO gate at all,
  // rendering unconditionally for any user who could reach this page —
  // the exact in-page counterpart of the sidebar's "New Project" bug.
  const canCreate = projectsNavFlags.canCreateProjects;

  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId && !activeWorkspace.isAllSelected) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Same resolution order as app/(main)/tickets/page.tsx: an explicit
  // ?departmentId= wins as an "explicit scoped view," validated against real
  // permission inside buildProjectListQuery below (never trusted as-is) — a
  // query param can narrow results, it can never widen access.
  const effectiveDepartmentId = params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  const query = await buildProjectListQuery(session.user.id, session.user.role, effectiveDepartmentId, params);
  if (query.denied) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <FolderKanban className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground text-sm max-w-sm">You don&apos;t have access to that department.</p>
      </div>
    );
  }
  const { where, orderBy, scope } = query;

  // "No projects yet" (empty state, nothing to filter) vs "No projects
  // match your filters" (data exists, current filters just exclude it all)
  // — andConditions itself now lives inside buildProjectListQuery, so the
  // distinction is re-derived here from the raw filter params instead.
  const hasActiveFilters = Object.entries(params).some(([key, value]) => {
    if (key === "page" || key === "pageSize" || key === "view" || key === "departmentId") return false;
    return typeof value === "string" && value.length > 0;
  });

  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);

  // Only the two queries that must see an identical snapshot (rows + the
  // total they're paginated against) go inside $transaction, matching
  // app/(main)/admin/users/page.tsx's reference pattern. Department
  // summaries/users are independent filter-option data — fetched in
  // parallel, but NOT inside the array-form $transaction, which requires
  // every element to be a raw PrismaPromise (getAccessibleDepartmentSummaries
  // is a composed service call, not one, and would break at runtime there).
  const [[projects, totalCount], departments, owners, members] = await Promise.all([
    prisma.$transaction([
      prisma.project.findMany({
        where,
        // id as a secondary sort key guarantees a fully deterministic order
        // even when two projects share the exact same primary sort value —
        // required for stable pagination (no row ever skipped or duplicated
        // across pages purely due to a value collision). orderBy is either
        // the canonical default (no/invalid ?sortBy=) or one whitelisted
        // column (PROJECT_SORT_KEYS in project-query-service.ts), always
        // with the same id tie-breaker — see lib/list-sort.ts.
        orderBy,
        skip: (requestedPage - 1) * pageSize,
        take: pageSize,
        include: {
          owner: { select: { id: true, name: true, image: true } },
          // Authoritative full Owner set (always contains `owner` above —
          // see Project.owners' own schema doc comment) and Audience — both
          // small, bounded relations (same cost profile as `members`
          // already selected below), added ONLY so the list preview can
          // show them without a second per-row fetch. Empty for every
          // manual Project.
          owners: { select: { id: true, name: true, image: true } },
          audience: { select: { id: true, name: true, image: true } },
          department: { select: { id: true, name: true } },
          members: { select: { id: true, name: true, image: true } },
          // Cheap nullable to-one relation — lets the list preview link
          // back to the originating Project Request without a second
          // fetch; null for every manual Project.
          projectRequest: { select: { id: true, title: true } },
          _count: { select: { activities: true } },
        },
      }),
      prisma.project.count({ where }),
    ]),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "project.view"),
    // Owner/Member filter-dropdown options — built from the REAL Project.owner/
    // Project.members relations, scoped by the exact same authorized+department
    // `scope` the main list query above uses as its own base condition (never a
    // disconnected, hardcoded-role User query — see getProjectOwnerOptions'
    // own doc comment). Independent of `where` (which also carries status/
    // priority/date/etc. filters) so the option lists stay stable as those
    // OTHER filters change — only Department narrows them, per spec.
    getProjectOwnerOptions(scope),
    getProjectMemberOptions(scope),
  ]);

  const pagination = computePagination(totalCount, requestedPage, pageSize);
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

  // Overdue is derived, never stored — resolved fresh against each project's
  // department's current terminal-status configuration (lib/status-terminal.ts),
  // bulk-loaded once for the current page's departments only (no N+1).
  const terminalConfigs = await getProjectTerminalConfigsForDepartments(
    projects.map((p) => p.departmentId).filter((id): id is string => !!id)
  );
  const now = new Date();
  // Project.budget/estimatedCost/actualCost no longer exist as DB columns
  // at all (removed — see
  // prisma/migrations/20261005090000_remove_project_budget_and_cost_columns);
  // the Decimal-crossing-the-RSC-boundary conversion this spread used to
  // need for them is gone along with the columns themselves.
  const projectsWithOverdue = projects.map((p) => ({
    ...p,
    overdue: isProjectOverdue(p.endDate, resolveProjectTerminal(terminalConfigs, p.departmentId, p.status), now),
  }));

  return (
    <div className="space-y-6">
      <ProjectListLiveRefresh />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground mt-1">
            Manage IT projects and initiatives
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle defaultView="list" />
          <ExportProjectsButton />
          {canCreate && (
            <Button asChild>
              <Link href="/projects/new">
                <Plus className="h-4 w-4 mr-2" />
                New Project
              </Link>
            </Button>
          )}
        </div>
      </div>

      <ProjectFilters options={{ departments, owners, members }} />

      {projects.length === 0 ? (
        <div className="text-center py-20">
          <FolderKanban className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            {totalCount === 0 && !hasActiveFilters ? "No projects yet." : "No projects match your filters."}
          </p>
          <Button asChild className="mt-4">
            <Link href="/projects/new">Create First Project</Link>
          </Button>
        </div>
      ) : (
        <>
          <ProjectList projects={projectsWithOverdue} defaultView="list" />
          <ProjectPaginationBar pagination={pagination} />
        </>
      )}
    </div>
  );
}
