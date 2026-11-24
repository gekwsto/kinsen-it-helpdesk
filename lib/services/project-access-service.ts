/**
 * The ONLY place Project Audience (individual OR organizational) and
 * Owner(s) membership has any effect on authorization — extends read
 * ("project.view"-equivalent) access beyond the normal Department-scoped
 * grant. Two independent extensions live here, with two different scopes:
 *
 *   1. AUDIENCE (individual Users, Departments, Business Units) — see
 *      buildProjectAudienceWhere in project-audience-service.ts for the
 *      ONE canonical predicate, shared verbatim with the list/Gantt/
 *      dashboard/search side (buildProjectListWhere in
 *      department-scope-service.ts) so record-level and list-level
 *      visibility can never disagree. Available on EVERY Project, manual
 *      or request-origin (as of Phase 1.1 — individual Audience was
 *      request-origin-only in Phase 1; Departments/Business Units always
 *      were universal). Resolved DYNAMICALLY against the current,
 *      currently-active DepartmentMembership graph — an org-chart change
 *      takes effect immediately, with nothing stored on the Project itself
 *      to go stale or need re-syncing.
 *   2. Owner(s) (owners User[]) — the pre-existing, UNCHANGED restriction:
 *      only ever consulted for a request-origin Project (see that
 *      relation's own schema doc comment). Phase 1.1 explicitly does NOT
 *      touch Project Owner semantics; this stays exactly as it was, and is
 *      deliberately NOT part of buildProjectAudienceWhere (so it is also,
 *      correctly, still absent from every list/Gantt/dashboard consumer).
 *
 * Deliberately NOT folded into the generic, widely-shared
 * hasEffectiveEntityPermission (department-scope-service.ts) — that
 * function is also used by Tickets and Activities, which have no concept
 * of Audience/Owner(s) at all; baking Project-specific logic into it would
 * be exactly the kind of "page-specific permission bypass hack" this
 * feature's own spec forbids, just smuggled into a shared function
 * instead of a page. This wraps it instead: the existing Department-scoped
 * check always runs first (global grant OR the Project's own Department
 * grant — completely unchanged, still the ONLY path to project.edit/
 * project.delete for ANY Project).
 *
 * NEVER used for project.edit/project.delete — every Audience/Owner path
 * here grants read access only. Audience membership does NOT automatically
 * grant edit/delete/ownership/membership/Project Request/Ticket/Activity
 * access (see this feature's own spec).
 */
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";
import { buildProjectAudienceWhere } from "@/lib/services/project-audience-service";

export async function hasProjectViewAccess(
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  project: { id: string; departmentId: string | null; projectRequestId: string | null }
): Promise<boolean> {
  const departmental = await hasEffectiveEntityPermission(userId, role, customRoleId, project.departmentId, "project.view");
  if (departmental) return true;

  // Audience (individual Users, Departments, Business Units) — the SAME
  // where-fragment the list/Gantt/dashboard/search side ORs into its own
  // query (see buildProjectListWhere), just scoped down to this one
  // already-identified Project via `id` instead of applied across a list.
  const audienceMatch = await prisma.project.findFirst({
    where: { id: project.id, ...buildProjectAudienceWhere(userId) },
    select: { id: true },
  });
  if (audienceMatch) return true;

  // Owner(s) only ever matter for a request-origin Project — a manual
  // Project's `owners` relation just mirrors the single creator/owner
  // already covered by the Department check above, so this lookup is
  // skipped entirely rather than running a pointless extra query.
  // UNCHANGED by Phase 1.1 (Project Owner semantics are explicitly out of
  // scope for this task).
  if (!project.projectRequestId) return false;

  const ownerMatch = await prisma.project.findFirst({
    where: { id: project.id, owners: { some: { id: userId } } },
    select: { id: true },
  });
  return !!ownerMatch;
}
