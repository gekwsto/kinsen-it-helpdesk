import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { parsePageParam, parsePageSizeParam, computePagination } from "@/lib/pagination";
import { resolveApprovalScope, buildAwaitingMyApprovalWhere, buildAwaitingMyIntermediateApprovalWhere, buildHistoryWhere } from "@/lib/services/project-request-service";
import { ProjectRequestTable } from "@/components/project-requests/project-request-table";
import { cn } from "@/lib/utils";
import type { Prisma } from "@prisma/client";

const TABS = [
  { key: "mine", label: "My Requests" },
  { key: "awaitingIntermediate", label: "Awaiting My Intermediate Approval" },
  { key: "awaiting", label: "Awaiting My Approval" },
  { key: "history", label: "History" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function resolveTab(raw: string | undefined): TabKey {
  return TABS.some((t) => t.key === raw) ? (raw as TabKey) : "mine";
}

interface SearchParams {
  tab?: string;
  page?: string;
  pageSize?: string;
}

export default async function ProjectRequestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const params = await searchParams;
  const tab = resolveTab(params.tab);
  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);
  const skip = (requestedPage - 1) * pageSize;

  // Every visibility rule below is derived from real, server-verified facts
  // (requesterId === me, or effective projectRequest.approve for the
  // request's own department) — never the active workspace, never a
  // broader "any admin" shortcut.
  const scope = await resolveApprovalScope(session.user.id, session.user.role, session.user.customRoleId);

  let where: Prisma.ProjectRequestWhereInput;
  if (tab === "mine") {
    where = { requesterId: session.user.id };
  } else if (tab === "awaitingIntermediate") {
    where = buildAwaitingMyIntermediateApprovalWhere(session.user.id);
  } else if (tab === "awaiting") {
    where = buildAwaitingMyApprovalWhere(session.user.id, scope);
  } else {
    where = buildHistoryWhere(session.user.id, scope);
  }

  const [requests, total] = await Promise.all([
    prisma.projectRequest.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      include: {
        projectType: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        requester: { select: { id: true, name: true, email: true } },
        approver: { select: { id: true, name: true, email: true } },
        intermediateApprovers: {
          include: { approver: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        },
        project: { select: { id: true, title: true } },
      },
    }),
    prisma.projectRequest.count({ where }),
  ]);

  const pagination = computePagination(total, requestedPage, pageSize);

  const tabHref = (key: TabKey) => `/project-requests?tab=${key}`;
  const pageHref = (page: number) => `/project-requests?tab=${tab}&page=${page}`;

  // Per-row canDecideNow from the SAME scope already resolved above for the
  // "awaiting"/"history" where-clauses — zero additional queries (no
  // per-row permission lookup, no N+1). A row is decidable now iff it's
  // still PENDING_APPROVAL AND this user's scope covers its department
  // (global grant -> every department; department-scoped grant -> only
  // those departments) — the exact same rule buildAwaitingMyApprovalWhere
  // already encodes, just evaluated per already-fetched row instead of in
  // SQL.
  const rowsWithActions = requests.map((r) => ({
    ...r,
    canDecideNow: r.status === "PENDING_APPROVAL" && (scope.hasGlobalApprove || scope.approveDepartmentIds.includes(r.departmentId)),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Project Requests</h1>
          <p className="text-muted-foreground mt-1">Requests to start a new Project, and their approval status</p>
        </div>
        <Button asChild>
          <Link href="/project-requests/new">
            <Plus className="h-4 w-4 mr-2" />
            New Request
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className={cn(
              "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <ProjectRequestTable
        requests={rowsWithActions}
        emptyMessage={
          tab === "mine"
            ? "You haven't submitted any Project Requests yet."
            : tab === "awaitingIntermediate"
            ? "Nothing is awaiting your intermediate approval."
            : tab === "awaiting"
            ? "Nothing is awaiting your approval."
            : "No decided requests to show."
        }
      />

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {pagination.startIndex}–{pagination.endIndex} of {pagination.totalCount}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={!pagination.hasPreviousPage} asChild={pagination.hasPreviousPage}>
              {pagination.hasPreviousPage ? <Link href={pageHref(pagination.page - 1)}>Previous</Link> : <span>Previous</span>}
            </Button>
            <Button variant="outline" size="sm" disabled={!pagination.hasNextPage} asChild={pagination.hasNextPage}>
              {pagination.hasNextPage ? <Link href={pageHref(pagination.page + 1)}>Next</Link> : <span>Next</span>}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
