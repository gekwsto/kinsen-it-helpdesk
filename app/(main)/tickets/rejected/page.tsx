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
import { Archive } from "lucide-react";
import { PendingTicketStatus } from "@prisma/client";
import { parsePageParam, parsePageSizeParam, computePagination, isOutOfRange } from "@/lib/pagination";

interface SearchParams {
  page?: string;
  pageSize?: string;
  departmentId?: string;
  fromEmail?: string;
  subject?: string;
  receivedAfter?: string;
  receivedBefore?: string;
}

/** Preserves every param except `page` — same pattern as app/(main)/tickets/pending/page.tsx's own buildCanonicalUrl. */
function buildCanonicalUrl(params: SearchParams, page: number): string {
  const canonical = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "page") continue;
    if (typeof value === "string" && value) canonical.set(key, value);
  }
  canonical.set("page", String(page));
  return `/tickets/rejected?${canonical.toString()}`;
}

/**
 * Rejected Tickets — the recovery/archive view of the SAME PendingTicket
 * lifecycle /tickets/pending already manages, filtered to `status:
 * REJECTED` only. Deliberately does NOT accept a `?status=` param at all
 * (unlike /tickets/pending) — this route is intrinsically REJECTED-only,
 * never influenced by a stray query string. Reuses the exact same
 * scoping (buildPendingTicketListWhere), permission (ticket.pending.view
 * to list/preview, ticket.pending.accept to recover), filters component,
 * table component, and pagination infrastructure as Pending — no second
 * implementation of any of that.
 */
export default async function RejectedTicketsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Same review capability as Pending Tickets — not a new permission.
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

  const andConditions: any[] = [scope, { status: PendingTicketStatus.REJECTED }];
  if (params.fromEmail) andConditions.push({ fromEmail: { contains: params.fromEmail, mode: "insensitive" } });
  if (params.subject) andConditions.push({ subject: { contains: params.subject, mode: "insensitive" } });
  if (params.receivedAfter) andConditions.push({ receivedAt: { gte: new Date(params.receivedAfter) } });
  if (params.receivedBefore) andConditions.push({ receivedAt: { lte: new Date(params.receivedBefore) } });

  const where: any = { AND: andConditions };

  const [rejectedTickets, total, globalAccept, acceptDepartments, departments] = await Promise.all([
    prisma.pendingTicket.findMany({
      where,
      skip,
      take: pageSize,
      // `id` as a secondary sort key guarantees fully deterministic
      // pagination even when two rejected tickets share the exact same
      // receivedAt — same pattern as /tickets/pending.
      orderBy: [{ receivedAt: "desc" }, { id: "asc" }],
      include: {
        department: { select: { id: true, name: true } },
        requester: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.pendingTicket.count({ where }),
    hasPermission(session.user.role, "ticket.pending.accept", session.user.customRoleId),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "ticket.pending.accept"),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "ticket.pending.view"),
  ]);

  const pagination = computePagination(total, requestedPage, pageSize);
  if (isOutOfRange(requestedPage, pagination)) {
    redirect(buildCanonicalUrl(params, pagination.page));
  }

  // UI-only hint for whether to render "Create Ticket" at all — the API
  // route is the real, per-record-department gate (requireDepartmentPermission/
  // hasPermission), so a wrong guess here only ever costs an extra click +
  // a clear "Forbidden" toast, never a security gap.
  const canAccept = globalAccept || acceptDepartments.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Archive className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Rejected Tickets</h1>
          <p className="text-muted-foreground mt-0.5">
            Rejected email requests retained for review. You can inspect them and create a ticket later if needed.
          </p>
        </div>
      </div>

      <PendingTicketFilters departments={departments} showStatusFilter={false} />

      <PendingTicketTable
        pendingTickets={rejectedTickets as any}
        pagination={pagination}
        canAccept={canAccept}
        canReject={false}
        showDepartmentPicker={!effectiveDepartmentId}
        allDepartments={departments}
        mode="rejected"
      />
    </div>
  );
}
