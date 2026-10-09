import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { getAccessibleDepartmentSummaries, getNavVisibilityFlags, hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { getActiveWorkspace } from "@/lib/services/workspace-service";
import { Button } from "@/components/ui/button";
import { ProjectForm } from "@/components/projects/project-form";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export default async function NewProjectPage({
  searchParams,
}: {
  searchParams: Promise<{ projectRequestId?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { projectRequestId } = await searchParams;

  // ─── Request-origin mode — a DIFFERENT authorization path from manual
  // creation entirely (see createProjectFromApprovedRequest's own doc
  // comment). The query param only tells us WHICH request to look up; every
  // actual decision below is re-resolved server-side from the real
  // database row, never trusted from the URL itself. This deliberately
  // bypasses the `canCreate` (project.create) gate below — the exact
  // recorded final approver completing setup for the ONE request they just
  // approved must never be blocked just because they don't separately hold
  // generic project.create in that department (that would be a real
  // regression: approve succeeds, then setup is refused). ───
  if (projectRequestId) {
    const request = await prisma.projectRequest.findUnique({
      where: { id: projectRequestId },
      select: {
        id: true,
        title: true,
        description: true,
        importance: true,
        status: true,
        approverId: true,
        department: { select: { id: true, name: true } },
        project: { select: { id: true } },
      },
    });

    // Doesn't exist, isn't APPROVED yet, or the viewer isn't its exact
    // recorded final approver — never a distinguishable error state here;
    // just send them back to the request itself, where canViewProjectRequest
    // decides what (if anything) they're allowed to see.
    if (!request || request.status !== "APPROVED" || request.approverId !== session.user.id) {
      redirect(`/project-requests/${projectRequestId}`);
    }

    // Already set up — resumability resolves straight to the existing
    // Project, never a second create, never a confusing "start over" form.
    if (request.project) {
      redirect(`/projects/${request.project.id}`);
    }

    return (
      // No max-width cap (previously max-w-2xl, then max-w-4xl) — a fixed
      // Tailwind cap always clamps at SOME fixed px value regardless of how
      // much room <main> actually has (measured: 896px of unused width at a
      // 1920px viewport, 1536px at 2560px). Fills whatever <main> gives it
      // instead (page padding is <main>'s own p-4 sm:p-6 in
      // app/(main)/layout.tsx, untouched here) — ProjectForm's own internal
      // grids distribute that width proportionally on their own.
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/project-requests/${request.id}`}>
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Set Up Project</h1>
            <p className="text-muted-foreground mt-1">From the approved Project Request &quot;{request.title}&quot;</p>
          </div>
        </div>

        <ProjectForm
          departments={[]}
          editableDepartmentIds={[]}
          mode="fromRequest"
          fromRequestId={request.id}
          fixedDepartmentId={request.department.id}
          fixedDepartmentName={request.department.name}
          fromRequestPrefill={{ title: request.title, description: request.description, priority: request.importance }}
        />
      </div>
    );
  }

  // Same union sidebar's "New Project" link uses (navFlags.canCreateProjects)
  // — department-scoped OR global project.create, never derived from
  // project.view. A raw hasPermission(...) call here only sees GLOBAL
  // grants and would wrongly deny a user whose project.create comes solely
  // from a department built-in/custom role. The actual per-department
  // eligibility (getAccessibleDepartmentSummaries below, and
  // resolveDepartmentForCreate in POST /api/projects) remains the
  // authoritative, workspace-aware check this page-level gate only mirrors.
  const canCreate = (
    await getNavVisibilityFlags(session.user.id, session.user.role, session.user.customRoleId)
  ).canCreateProjects;
  if (!canCreate) redirect("/projects");

  // Only departments this user can actually create a project in — the same
  // set resolveDepartmentForCreate (lib/services/department-scope-service.ts)
  // validates against on submit, so the dropdown never offers a choice the
  // API would reject.
  const [departments, activeWorkspace] = await Promise.all([
    getAccessibleDepartmentSummaries(session.user.id, session.user.role, "project.create"),
    getActiveWorkspace(session.user.id, session.user.role),
  ]);

  // project.create never implies project.edit — they're independently
  // grantable (see prisma/seed.ts; a role can hold one without the other,
  // same as project.edit/project.delete elsewhere in this app). Computed
  // per offered department via the SAME hasEffectiveEntityPermission union
  // (global grant OR that department's own grant) every other entity-edit
  // gate in this app uses — getAccessibleDepartmentSummaries alone isn't
  // enough here because its ADMIN/"canViewAllDepartments" fast path aside,
  // it only ever walks real DepartmentMemberships, so it would wrongly omit
  // a department for a user whose project.edit comes from a GLOBAL custom
  // role with no membership anywhere. This is the "canonical server-
  // computed capability" the Attachments section's visibility is gated on —
  // ProjectForm only ever checks membership in this pre-computed set, it
  // never decides the permission itself.
  const editableDepartmentIds = (
    await Promise.all(
      departments.map(async (d) =>
        (await hasEffectiveEntityPermission(session.user.id, session.user.role, session.user.customRoleId, d.id, "project.edit")) ? d.id : null
      )
    )
  ).filter((id): id is string => id !== null);

  // Preselect the active workspace if it's actually allowed; if there's
  // exactly one allowed department, that's the obvious choice regardless of
  // workspace state. Otherwise (multiple choices, or "All Workspaces"
  // selected) leave it unselected — the form requires an explicit pick.
  const activeIsAllowed =
    activeWorkspace.departmentId != null && departments.some((d) => d.id === activeWorkspace.departmentId);
  const defaultDepartmentId = activeIsAllowed
    ? (activeWorkspace.departmentId as string)
    : departments.length === 1
    ? departments[0].id
    : undefined;

  return (
    // No max-width cap — see the fromRequest branch above's own comment;
    // same rationale, applied consistently to the standalone (manual
    // creation) variant of this same page/form.
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/projects">
            <ChevronLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Project</h1>
          <p className="text-muted-foreground mt-1">Create a new IT project</p>
        </div>
      </div>

      <ProjectForm departments={departments} editableDepartmentIds={editableDepartmentIds} defaultDepartmentId={defaultDepartmentId} />
    </div>
  );
}
