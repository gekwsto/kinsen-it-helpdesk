import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildProjectListWhere, getAccessibleDepartmentSummaries, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { ViewToggle } from "@/components/ui/view-toggle";
import { ProjectList } from "@/components/projects/project-list";
import { ProjectFilters } from "@/components/projects/project-filters";
import { ProjectPaginationBar } from "@/components/projects/project-pagination-bar";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus, FolderKanban } from "lucide-react";
import { getProjectTerminalConfigsForDepartments, resolveProjectTerminal } from "@/lib/status-terminal";
import { isProjectOverdue } from "@/lib/overdue";
import {
  buildProjectSearchCondition,
  resolveProjectStatusGroupWhere,
  resolveProjectOverdueWhere,
  resolveProjectActivityWhere,
} from "@/lib/services/project-query-service";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";
import { ProjectStatus, Role } from "@prisma/client";

interface SearchParams {
  page?: string;
  pageSize?: string;
  view?: string;
  search?: string;
  /** Exact ProjectStatus enum value — distinct from statusGroup below. */
  status?: string;
  /** Terminal-status GROUP ("active" | "completed") — see lib/services/project-query-service.ts. Same semantics as the Projects Dashboard's Active/Completed KPI cards. */
  statusGroup?: string;
  /** "true" only — same rule as the Projects Dashboard's Overdue Projects card (lib/overdue.ts + ProjectStatusConfig terminal resolution). */
  overdue?: string;
  priority?: string;
  ownerId?: string;
  memberId?: string;
  departmentId?: string;
  subDepartmentId?: string;
  startDateAfter?: string;
  startDateBefore?: string;
  dueDateAfter?: string;
  dueDateBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  hasActivities?: string;
  /** "completed" | "incomplete" */
  activityStatus?: string;
  activityOverdue?: string;
}

const PROJECT_STATUS_VALUES = new Set<string>(Object.values(ProjectStatus));

/** Strict — rejects anything but exactly YYYY-MM-DD (the native `<input type="date">` format); never silently truncates garbage like a lenient `new Date()` call would. */
function parseStrictDate(raw: string | undefined): Date | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Strict — rejects non-digit-only strings (e.g. "2abc"), never a lenient parseInt() truncation. */
function parseStrictIntIn(raw: string | undefined, allowed: readonly number[]): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return allowed.includes(n) ? n : undefined;
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
  // permission by buildProjectListWhere below (never trusted as-is) — a
  // query param can narrow results, it can never widen access.
  const effectiveDepartmentId = params.departmentId ?? (activeWorkspace.isAllSelected ? undefined : activeWorkspace.departmentId);

  const scope = await buildProjectListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <FolderKanban className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground text-sm max-w-sm">You don&apos;t have access to that department.</p>
      </div>
    );
  }

  // ── Flat filters (everything except the terminal-status-dependent ones) ──
  const andConditions: Record<string, unknown>[] = [scope as Record<string, unknown>];

  if (params.subDepartmentId) andConditions.push({ subDepartmentId: params.subDepartmentId });
  if (params.search) andConditions.push(buildProjectSearchCondition(params.search));

  const exactStatus = params.status && PROJECT_STATUS_VALUES.has(params.status) ? (params.status as ProjectStatus) : undefined;
  if (exactStatus) andConditions.push({ status: exactStatus });

  const priority = parseStrictIntIn(params.priority, [1, 2, 3]);
  if (priority !== undefined) andConditions.push({ priority });

  if (params.ownerId) andConditions.push({ ownerId: params.ownerId });
  if (params.memberId) andConditions.push({ members: { some: { id: params.memberId } } });

  const startDateAfter = parseStrictDate(params.startDateAfter);
  const startDateBefore = parseStrictDate(params.startDateBefore);
  if (startDateAfter || startDateBefore) {
    andConditions.push({ startDate: { ...(startDateAfter ? { gte: startDateAfter } : {}), ...(startDateBefore ? { lte: startDateBefore } : {}) } });
  }
  const dueDateAfter = parseStrictDate(params.dueDateAfter);
  const dueDateBefore = parseStrictDate(params.dueDateBefore);
  if (dueDateAfter || dueDateBefore) {
    andConditions.push({ endDate: { ...(dueDateAfter ? { gte: dueDateAfter } : {}), ...(dueDateBefore ? { lte: dueDateBefore } : {}) } });
  }
  const createdAfter = parseStrictDate(params.createdAfter);
  const createdBefore = parseStrictDate(params.createdBefore);
  if (createdAfter || createdBefore) {
    andConditions.push({ createdAt: { ...(createdAfter ? { gte: createdAfter } : {}), ...(createdBefore ? { lte: createdBefore } : {}) } });
  }

  // A snapshot (spread copy), not a live reference — andConditions.push()
  // below must never retroactively change what an EARLIER resolve* call in
  // this same block already saw, or two terminal-dependent filters combined
  // together would silently narrow each other in push order rather than
  // being independently resolved against the same flat-filter base (the
  // Projects Dashboard's own KPI cards are likewise computed independently
  // against one shared projectWhere, never chained off each other).
  const flatWhere = { AND: [...andConditions] };

  // ── Terminal-status-dependent filters — resolved against the flat filters
  // above via the shared helpers also used by the Projects Dashboard, so a
  // dashboard card's count and this list's result count for the same
  // condition can never disagree. ──
  if (params.overdue === "true") {
    andConditions.push(await resolveProjectOverdueWhere(flatWhere));
  }
  const statusGroup = params.statusGroup === "active" || params.statusGroup === "completed" ? params.statusGroup : undefined;
  if (statusGroup) {
    andConditions.push(await resolveProjectStatusGroupWhere(flatWhere, statusGroup === "completed"));
  }
  if (params.hasActivities === "true") {
    andConditions.push(await resolveProjectActivityWhere(flatWhere, "has"));
  }
  const activityStatus = params.activityStatus === "completed" || params.activityStatus === "incomplete" ? params.activityStatus : undefined;
  if (activityStatus) {
    andConditions.push(await resolveProjectActivityWhere(flatWhere, activityStatus));
  }
  if (params.activityOverdue === "true") {
    andConditions.push(await resolveProjectActivityWhere(flatWhere, "overdue"));
  }

  const where = { AND: andConditions };

  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);

  // Only the two queries that must see an identical snapshot (rows + the
  // total they're paginated against) go inside $transaction, matching
  // app/(main)/admin/users/page.tsx's reference pattern. Department
  // summaries/users are independent filter-option data — fetched in
  // parallel, but NOT inside the array-form $transaction, which requires
  // every element to be a raw PrismaPromise (getAccessibleDepartmentSummaries
  // is a composed service call, not one, and would break at runtime there).
  const [[projects, totalCount], departments, users] = await Promise.all([
    prisma.$transaction([
      prisma.project.findMany({
        where,
        // id as a secondary sort key guarantees a fully deterministic order
        // even when two projects share the exact same createdAt — required
        // for stable pagination (no row ever skipped or duplicated across
        // pages purely due to timestamp collisions).
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: (requestedPage - 1) * pageSize,
        take: pageSize,
        include: {
          owner: { select: { id: true, name: true, image: true } },
          department: { select: { id: true, name: true } },
          members: { select: { id: true, name: true, image: true } },
          _count: { select: { activities: true } },
        },
      }),
      prisma.project.count({ where }),
    ]),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "project.view"),
    prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.IT_AGENT, Role.DEPARTMENT_MANAGER, Role.DIRECTOR] }, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
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
  const projectsWithOverdue = projects.map((p) => ({
    ...p,
    overdue: isProjectOverdue(p.endDate, resolveProjectTerminal(terminalConfigs, p.departmentId, p.status), now),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-muted-foreground mt-1">
            Manage IT projects and initiatives
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle />
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

      <ProjectFilters options={{ departments, users }} />

      {projects.length === 0 ? (
        <div className="text-center py-20">
          <FolderKanban className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">
            {totalCount === 0 && andConditions.length <= 1 ? "No projects yet." : "No projects match your filters."}
          </p>
          <Button asChild className="mt-4">
            <Link href="/projects/new">Create First Project</Link>
          </Button>
        </div>
      ) : (
        <>
          <ProjectList projects={projectsWithOverdue} />
          <ProjectPaginationBar pagination={pagination} />
        </>
      )}
    </div>
  );
}
