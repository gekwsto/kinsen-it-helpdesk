/**
 * The ONLY place Project Owner(s)/Audience membership has any effect on
 * authorization — extends read ("project.view"-equivalent) access to a
 * request-origin Project for its explicitly-selected Owner(s) and
 * Audience, who may now be ANY system-wide active user with no requirement
 * they hold any Department-scoped permission at all (see
 * prisma/schema.prisma's Project.owners/Project.audience doc comments and
 * lib/services/project-request-service.ts's createProjectFromApprovedRequest).
 *
 * Deliberately NOT folded into the generic, widely-shared
 * hasEffectiveEntityPermission (department-scope-service.ts) — that
 * function is also used by Tickets and Activities, which have no concept
 * of Owner(s)/Audience at all; baking Project-specific logic into it would
 * be exactly the kind of "page-specific permission bypass hack" this
 * feature's own spec forbids, just smuggled into a shared function
 * instead of a page. This wraps it instead: the existing Department-scoped
 * check always runs first (global grant OR the Project's own Department
 * grant — completely unchanged, still the ONLY path for a manual Project,
 * still the ONLY path to project.edit/project.delete for ANY Project), and
 * only a request-origin Project with a NON-passing Department check falls
 * through to the Owner(s)/Audience lookup below.
 *
 * NEVER used for project.edit/project.delete — Owner(s)/Audience grant
 * read access only. A request-origin Project's Owner(s) do NOT
 * automatically gain project.edit through this function; that remains
 * exactly the same Department-scoped project.edit grant it always was (see
 * this feature's own spec: "do not change normal Project semantics" and
 * "Audience does NOT automatically grant edit/delete/ownership/membership").
 */
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { hasEffectiveEntityPermission } from "@/lib/services/department-scope-service";

export async function hasProjectViewAccess(
  userId: string,
  role: Role,
  customRoleId: string | null | undefined,
  project: { id: string; departmentId: string | null; projectRequestId: string | null }
): Promise<boolean> {
  const departmental = await hasEffectiveEntityPermission(userId, role, customRoleId, project.departmentId, "project.view");
  if (departmental) return true;

  // Owner(s)/Audience only ever matter for a request-origin Project — a
  // manual Project's `owners`/`audience` relations are either empty or
  // (for `owners`) just mirror the single creator/owner already covered by
  // the Department check above, so this lookup is skipped entirely rather
  // than running a pointless extra query.
  if (!project.projectRequestId) return false;

  const follower = await prisma.project.findFirst({
    where: {
      id: project.id,
      OR: [{ owners: { some: { id: userId } } }, { audience: { some: { id: userId } } }],
    },
    select: { id: true },
  });
  return !!follower;
}
