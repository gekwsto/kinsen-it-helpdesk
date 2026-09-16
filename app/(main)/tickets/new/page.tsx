import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { getAccessibleDepartmentSummaries, getTicketDestinationDepartments, getNavVisibilityFlags } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { NoWorkspaceState, ChooseWorkspaceState } from "@/components/workspace/workspace-gate";
import { Role } from "@prisma/client";
import { CreateTicketForm } from "@/components/tickets/ticket-form";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ChevronRight, TicketPlus, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function NewTicketPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Same union sidebar's "Create Ticket" link uses (navFlags.canCreateTickets)
  // — department-scoped OR global ticket.create, never derived from
  // ticket.view. A raw hasPermission(...) call here only sees GLOBAL grants
  // and would wrongly deny a user whose ticket.create comes solely from a
  // department built-in/custom role (e.g. the built-in AGENT_ASSIGNEE
  // department role).
  const canCreate = (
    await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId)
  ).canCreateTickets;

  if (!canCreate) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-4">
        <ShieldOff className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Cannot create tickets</h1>
        <p className="text-muted-foreground text-sm max-w-sm">
          You don&apos;t have permission to create support tickets. Contact your administrator to request access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/tickets/created-by-me">View my tickets</Link>
        </Button>
      </div>
    );
  }

  // Same permission as the detail page and both backend routes (see
  // app/api/tickets/route.ts / app/api/tickets/[id]/route.ts) —
  // ticket.linkProjectActivity. No Ticket exists yet at this point, and the
  // destination department is picked IN the form (client-side, changeable
  // to any of destinationDepartments below) — so, unlike the ticket detail
  // page (one fixed ticket.departmentId), the correct authorization here is
  // DEPARTMENT-AWARE per the currently-selected destination, not a single
  // "usable somewhere" boolean (hasEffectiveModulePermission would wrongly
  // show the link UI for a department the user has no grant in, just
  // because they have one in some OTHER department — backend-safe since
  // POST re-checks the real resolved department, but a misleading UI).
  // Two pieces are resolved here, both reused from the existing canonical
  // permission architecture (no new endpoint, no role-name check), and the
  // actual per-selection decision is made CLIENT-SIDE in ticket-form.tsx
  // against whichever department is currently selected:
  //   - hasGlobalLinkPermission: the plain global grant (hasPermission) —
  //     if true, linking is available for EVERY valid destination.
  //   - linkPermissionDepartmentIds: exactly which destination departments
  //     the user's OWN DepartmentMembership/custom Department role grants
  //     it in (getAccessibleDepartmentSummaries — the same department-
  //     permission primitive canActOnEntity itself resolves through, and
  //     the same one projectCreateDepartmentIds/activityCreateDepartmentIds
  //     below already use for the analogous project.create/activity.create
  //     per-department decision).
  const [hasGlobalLinkPermission, linkPermissionDepartments] = await Promise.all([
    hasPermission(session.user.role, "ticket.linkProjectActivity", session.user.customRoleId),
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "ticket.linkProjectActivity"),
  ]);
  const linkPermissionDepartmentIds = linkPermissionDepartments.map((d) => d.id);
  const canLinkProjectActivityAnywhere = hasGlobalLinkPermission || linkPermissionDepartmentIds.length > 0;

  // Active workspace decides the default department (Phase 2B) — a plain
  // member with exactly one accessible department never sees a picker at
  // all (handled in the form component); an ambiguous/missing workspace
  // stops here rather than rendering a form that would just fail to submit.
  const activeWorkspace = await getActiveWorkspace(session.user.id, session.user.role);
  if (!activeWorkspace.departmentId) {
    return activeWorkspace.departments.length === 0 ? (
      <NoWorkspaceState />
    ) : (
      <ChooseWorkspaceState departments={activeWorkspace.departments} />
    );
  }

  // Department here means the ticket's DESTINATION — who it's being sent
  // to — not a department the requester must already belong to (a Finance
  // user must be able to address a ticket to IT without ever holding an IT
  // DepartmentMembership row). So this is every ACTIVE department in the
  // organization (getTicketDestinationDepartments), NOT
  // getAccessibleDepartmentSummaries(..., "ticket.create") — that helper
  // stays membership-scoped and is still correctly used below for
  // project.create/activity.create, where operating inside the department
  // genuinely is required. Whether this user may create a ticket AT ALL
  // (independent of which destination they pick) is the separate
  // `canCreate` gate above; POST /api/tickets re-derives both independently
  // via resolveTicketDestinationDepartment — a client-supplied departmentId
  // is never trusted here either.
  const destinationDepartments = await getTicketDestinationDepartments();
  const destinationDepartmentIds = destinationDepartments.map((d) => d.id);

  // Both category and priority are strictly department-owned now (no more
  // global fallback) — scoped to every valid destination department, since
  // the user can address the ticket to any of them; the ticket form then
  // re-filters this list down to just the currently-selected department
  // client-side (see ticket-form.tsx), the same pattern already used for
  // sub-departments.
  const scopedWhere = {
    isActive: true,
    departmentId: { in: destinationDepartmentIds },
  };

  // Project/Activity options themselves are no longer loaded here — the
  // form fetches them client-side, department-scoped, from the same
  // GET /api/projects / GET /api/activities the standalone list pages use
  // (see components/tickets/ticket-form.tsx), never an unbounded
  // "every project/activity in the system" query. Only the (small, bounded)
  // set of departments the user also holds project.create/activity.create
  // in is resolved here — reused as-is by the shared
  // getAccessibleDepartmentSummaries department-permission helper, not a
  // new/parallel permission check.
  const [categories, priorities, itAgents, projectCreateDepartments, activityCreateDepartments] =
    await Promise.all([
      prisma.ticketCategory.findMany({
        where: scopedWhere,
        orderBy: { name: "asc" },
        select: { id: true, name: true, departmentId: true },
      }),
      prisma.ticketPriority.findMany({
        where: scopedWhere,
        orderBy: { level: "desc" },
        select: { id: true, name: true, color: true, level: true, departmentId: true },
      }),
      prisma.user.findMany({
        where: { role: { in: [Role.IT_AGENT, Role.ADMIN] }, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, image: true },
        take: 6,
      }),
      // Only a user with ticket.linkProjectActivity SOMEWHERE can ever link
      // a ticket to a Project/Activity at all (see canLinkProjectActivityAnywhere
      // above) — no need to resolve these for anyone else. The per-selected-
      // department decision (does THIS grant even cover the department the
      // user has currently picked) is made client-side.
      canLinkProjectActivityAnywhere ? getAccessibleDepartmentSummaries(session.user.id, session.user.role, "project.create") : Promise.resolve([]),
      canLinkProjectActivityAnywhere ? getAccessibleDepartmentSummaries(session.user.id, session.user.role, "activity.create") : Promise.resolve([]),
    ]);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/tickets" className="hover:text-foreground transition-colors">
          Tickets
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-foreground font-medium">New Ticket</span>
      </div>

      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <TicketPlus className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create New Ticket</h1>
          <p className="text-muted-foreground mt-0.5">
            Submit a support request and our IT team will get back to you shortly.
          </p>
        </div>
      </div>

      <CreateTicketForm
        categories={categories}
        priorities={priorities}
        departments={destinationDepartments}
        defaultDepartmentId={activeWorkspace.departmentId}
        itAgents={itAgents}
        hasGlobalLinkPermission={hasGlobalLinkPermission}
        linkPermissionDepartmentIds={linkPermissionDepartmentIds}
        projectCreateDepartmentIds={projectCreateDepartments.map((d) => d.id)}
        activityCreateDepartmentIds={activityCreateDepartments.map((d) => d.id)}
      />
    </div>
  );
}
