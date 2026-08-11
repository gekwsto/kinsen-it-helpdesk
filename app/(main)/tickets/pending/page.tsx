import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import {
  buildPendingTicketListWhere,
  getAccessibleDepartmentSummaries,
  getNavVisibilityFlags,
} from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { PendingTicketTable } from "@/components/tickets/pending-ticket-table";
import { PendingTicketFilters } from "@/components/tickets/pending-ticket-filters";
import { redirect } from "next/navigation";
import { Inbox } from "lucide-react";
import { PendingTicketStatus } from "@prisma/client";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";

interface SearchParams {
  page?: string;
  pageSize?: string;
  departmentId?: string;
  fromEmail?: string;
  subject?: string;
  status?: string;
  receivedAfter?: string;
  receivedBefore?: string;
}

/** Preserves every param except `page` — same pattern as app/(main)/projects/page.tsx's own buildCanonicalUrl. */
function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/tickets/pending?${canonical.toString()}`;
}

export default async function PendingTicketsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const navFlags = await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId);
  if (!navFlags.canViewPendingTickets) redirect("/dashboard");

  const params = await searchParams;
  const requestedPage = parsePageParam(params.page);
  const pageSize = parsePageSizeParam(params.pageSize);
  const skip = (requestedPage - 1) * pageSize;

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

  const scope = await buildPendingTicketListWhere(session.user.id, session.user.role, effectiveDepartmentId);
  if ("denied" in scope) redirect("/dashboard");

  const status = params.status && params.status in PendingTicketStatus ? (params.status as PendingTicketStatus) : PendingTicketStatus.PENDING;

  const andConditions: any[] = [scope, { status }];
  if (params.fromEmail) andConditions.push({ fromEmail: { contains: params.fromEmail, mode: "insensitive" } });
  if (params.subject) andConditions.push({ subject: { contains: params.subject, mode: "insensitive" } });
  if (params.receivedAfter) andConditions.push({ receivedAt: { gte: new Date(params.receivedAfter) } });
  if (params.receivedBefore) andConditions.push({ receivedAt: { lte: new Date(params.receivedBefore) } });

  const where: any = { AND: andConditions };

  const [pendingTickets, total, globalAccept, globalReject, acceptDepartments, rejectDepartments, departments] = await Promise.all([
    prisma.pendingTicket.findMany({
      where,
      skip,
      take: pageSize,
      // `id` as a secondary sort key guarantees fully deterministic
      // pagination even when two pending tickets share the exact same
      // receivedAt — same pattern as the Ticket list pages.
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      include: {
        department: { select: { id: true, name: true } },
        requester: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.pendingTicket.count({ where }),
    hasPermission(session.user.role, "ticket.pending.accept", session.user.customRoleId),
    hasPermission(session.user.role, "ticket.pending.reject", session.user.customRoleId),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "ticket.pending.accept"),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "ticket.pending.reject"),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "ticket.pending.view"),
  ]);

  const pagination = computePagination(total, requestedPage, pageSize);
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

  // UI-only hint for whether to render the Accept/Reject buttons at all —
  // the API routes are the real, per-pending-ticket-department gate
  // (requireDepartmentPermission/hasPermission), so a wrong guess here only
  // ever costs an extra click + a clear "Forbidden" toast, never a security
  // gap. Covers both a global-role grant (e.g. IT_AGENT) and a department-
  // membership grant (e.g. DEPARTMENT_MANAGER) — either makes the action
  // reachable for at least one row.
  const canAccept = globalAccept || acceptDepartments.length > 0;
  const canReject = globalReject || rejectDepartments.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Inbox className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Pending Tickets</h1>
          <p className="text-muted-foreground mt-0.5">
            Emails awaiting review — accept to create a real ticket, or reject to discard.
          </p>
        </div>
      </div>

      <PendingTicketFilters departments={departments} />

      <PendingTicketTable
        pendingTickets={pendingTickets as any}
        pagination={pagination}
        canAccept={canAccept}
        canReject={canReject}
        showDepartmentPicker={!effectiveDepartmentId}
        allDepartments={departments}
      />
    </div>
  );
}
