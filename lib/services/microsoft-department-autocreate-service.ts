/**
 * Optional, env-gated: auto-creates a Department (+ a default
 * PROFILE_DEPARTMENT mapping) the first time Microsoft login sync sees a
 * Graph `department` value with no matching MicrosoftDepartmentMapping and
 * no existing local Department. Disabled unless AUTO_CREATE_GRAPH_DEPARTMENTS
 * is exactly "true" — an unattended login is the one place in this app a
 * background process would create org structure, not just membership rows,
 * so this defaults off until explicitly opted into.
 *
 * Callers (microsoft-department-sync-service.ts) are responsible for only
 * invoking this when no active PROFILE_DEPARTMENT mapping already exists for
 * the value — explicit mappings must always win and are never reconsidered
 * here.
 */
import { DepartmentRole, MembershipSource, MicrosoftMappingSourceType, Prisma } from "@prisma/client";
import { createDepartment, getDepartmentBySlug, slugify } from "@/lib/services/department-service";
import { createMapping } from "@/lib/services/microsoft-mapping-service";
import type { ResolvedMembership } from "@/types/department";

function isAutoCreateEnabled(): boolean {
  return process.env.AUTO_CREATE_GRAPH_DEPARTMENTS === "true";
}

/**
 * Returns a ResolvedMembership (REQUESTER in a found-or-newly-created
 * department) if auto-create is enabled and applicable, or null if the
 * feature is disabled, the value is empty/whitespace, or a matching
 * department already exists and mapping creation is left to the admin.
 * Never throws — a race on the department slug or the mapping's unique
 * constraint is treated as "someone else already handled it," not an error.
 */
export async function maybeAutoCreateDepartmentForGraphValue(
  value: string
): Promise<ResolvedMembership | null> {
  if (!isAutoCreateEnabled()) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const slug = slugify(trimmed);
  if (!slug) return null; // e.g. a value that's entirely punctuation/whitespace after trim

  let department = await getDepartmentBySlug(slug);

  if (!department) {
    try {
      department = await createDepartment({ name: trimmed });
      console.log("[microsoft-directory] Auto-created department from Graph value", {
        name: trimmed,
        slug: department.slug,
      });
    } catch (err) {
      // Race: a concurrent login for the same brand-new department may have
      // created it a moment earlier. Re-read by slug rather than failing
      // this login.
      department = await getDepartmentBySlug(slug);
      if (!department) throw err;
    }
  }

  try {
    await createMapping({
      sourceType: MicrosoftMappingSourceType.PROFILE_DEPARTMENT,
      microsoftValue: trimmed,
      departmentId: department.id,
      role: DepartmentRole.REQUESTER,
    });
    console.log("[microsoft-directory] Auto-created default mapping", {
      microsoftValue: trimmed,
      departmentSlug: department.slug,
    });
  } catch (err) {
    // Race or already-created by a prior partial run — the unique
    // constraint on (sourceType, microsoftValue) is the safety net either
    // way; anything else is a real error worth surfacing.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
      throw err;
    }
  }

  return {
    departmentId: department.id,
    role: DepartmentRole.REQUESTER,
    source: MembershipSource.MICROSOFT_DEPARTMENT,
  };
}
