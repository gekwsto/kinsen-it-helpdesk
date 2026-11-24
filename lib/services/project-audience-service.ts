/**
 * THE central Project Audience/Responsible-People module — write-time
 * validation for every non-Owner/Member relationship that grants read-only
 * Project visibility (individual Audience Users, Audience Departments,
 * Audience Business Units, and — Phase 2 — Responsible People) AND the one
 * canonical Prisma `where`-predicate (buildProjectAudienceWhere below) that
 * defines what "extended read visibility" means. Every consumer — the
 * record-level check (hasProjectViewAccess in project-access-service.ts)
 * and every list/Gantt/dashboard/search/export consumer (buildProjectListWhere
 * in department-scope-service.ts) — uses that SAME predicate, so "can this
 * user see this one Project" and "does this Project appear in that user's
 * list" can never silently disagree (Phase 1.1's own "centralize... with
 * equivalent semantics" requirement, reused verbatim for Phase 2).
 *
 * Responsible People (Project.responsiblePeople) is its OWN relation —
 * Phase 2 is explicit that it must never be written into `Project.audience`
 * or any other existing relation — but it grants the exact same read-only
 * visibility, so it is OR'd into this same predicate rather than given a
 * parallel one. "Audience" in this file's name/doc comments below should be
 * read as this broader "extended visibility" concept; the UI/API/schema
 * still track Responsible People as a visibly separate field everywhere
 * else (picker, column, label).
 *
 * ─── Validation (write-time) ───
 * Every id a client submits is independently re-verified here against
 * real, currently-existing rows before being connected — never trusted
 * as-is, same "never trust a client-submitted id list" contract as
 * resolveActiveDepartmentMemberIds elsewhere in this app.
 *
 * Deduplicated (never a false validation failure merely because a client
 * sent the same id twice — Prisma's own `connect`/`set` would already
 * dedupe at the DB level regardless, but this keeps the validated id list
 * itself clean for a caller that also needs the count).
 *
 * Department ids must additionally be ACTIVE to be newly SELECTED — an
 * admin should not be able to add a deactivated department as an audience
 * target going forward. This is a selection-time gate only: a department
 * already connected as audience that is LATER deactivated is never
 * automatically disconnected (same "preserve what's already there, only
 * selection going forward is restricted" convention this app already uses
 * for e.g. Expense Type — see PATCH /api/projects/[id]'s own handling).
 * BusinessUnit has no isActive column at all, so only existence is checked.
 * resolveSystemWideActiveUserIds (individual Users — Owner(s)/Audience) is
 * the exact same "any active user in the system" rule it always was,
 * simply relocated here (from project-request-service.ts, which now
 * imports it from this file instead of keeping its own copy) now that a
 * SECOND caller (manual Project creation/edit) needs it too — Phase 1.1
 * removes the request-origin-only restriction specifically for individual
 * Audience, never for Owner(s), which stays exactly as it was.
 *
 * ─── Authorization (read-time) ───
 * buildProjectAudienceWhere(userId) expresses, as a single Prisma
 * `Project` where-fragment, every way a non-RBAC relationship currently
 * grants read access to a Project:
 *   1. Individual Audience User — a direct row in Project.audience.
 *      Available on EVERY Project as of Phase 1.1 (previously request-
 *      origin only).
 *   2. Audience Department — the user holds a currently ACTIVE
 *      DepartmentMembership in a currently ACTIVE Department that is one
 *      of the Project's audienceDepartments.
 *   3. Audience Business Unit — the user holds a currently ACTIVE
 *      DepartmentMembership in a currently ACTIVE Department that belongs
 *      to one of the Project's audienceBusinessUnits (the hierarchy
 *      roll-up).
 *   4. Responsible Person — Phase 2 — a direct row in
 *      Project.responsiblePeople. Available on EVERY Project regardless
 *      of Department or status, same as (1).
 * "Currently active" in (2)/(3) is re-resolved on every call, never
 * snapshotted — an org-chart change (a membership added/removed, a
 * Department deactivated) takes effect immediately, with nothing stored on
 * the Project itself to go stale; (1)/(4) are likewise re-resolved live —
 * a Responsible People assignment change takes effect immediately too,
 * with no caching anywhere in this path. This is NEVER folded into
 * hasEffectiveEntityPermission/buildEntityListWhere (department-scope-
 * service.ts) — those are shared with Tickets/Activities/Resource
 * Planning, which have no Audience/Responsible-People concept at all; this
 * file stays the one Project-specific extension point, consumed
 * explicitly by both the record-level and list-level callers instead.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export type ProjectAudienceOrgResolution =
  | { ok: true; departmentIds: string[]; businessUnitIds: string[] }
  | { ok: false; code: "invalid_audience_department" | "invalid_audience_business_unit" };

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
}

export async function resolveProjectAudienceOrganizationalIds(
  rawDepartmentIds: string[],
  rawBusinessUnitIds: string[]
): Promise<ProjectAudienceOrgResolution> {
  const departmentIds = dedupe(rawDepartmentIds);
  const businessUnitIds = dedupe(rawBusinessUnitIds);

  if (departmentIds.length > 0) {
    const activeCount = await prisma.department.count({ where: { id: { in: departmentIds }, isActive: true } });
    if (activeCount !== departmentIds.length) return { ok: false, code: "invalid_audience_department" };
  }
  if (businessUnitIds.length > 0) {
    const existingCount = await prisma.businessUnit.count({ where: { id: { in: businessUnitIds } } });
    if (existingCount !== businessUnitIds.length) return { ok: false, code: "invalid_audience_business_unit" };
  }

  return { ok: true, departmentIds, businessUnitIds };
}

/**
 * Validates a set of user ids for Owner(s)/Audience — deliberately NEVER
 * Department/Workspace-scoped: both are "ANY active user in the entire
 * system" (no requirement the user belongs to the Project's department,
 * holds any particular permission, or is already a Member). Deduplicates,
 * rejects blank entries, and returns null if ANY id doesn't resolve to a
 * real, currently active User — never silently drops an invalid one and
 * proceeds with the rest (fail closed, same philosophy as the Member-
 * eligibility loop in the Project routes). Used for Owner(s) at request-
 * origin creation (unchanged) and, as of Phase 1.1, for individual
 * Audience at every creation/edit path (manual and request-origin alike).
 */
export async function resolveSystemWideActiveUserIds(ids: string[]): Promise<string[] | null> {
  const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
  if (deduped.length === 0) return deduped;
  const activeCount = await prisma.user.count({ where: { id: { in: deduped }, isActive: true } });
  return activeCount === deduped.length ? deduped : null;
}

export function buildProjectAudienceWhere(userId: string): Prisma.ProjectWhereInput {
  return {
    OR: [
      { audience: { some: { id: userId } } },
      {
        audienceDepartments: {
          some: {
            isActive: true,
            memberships: { some: { userId, isActive: true } },
          },
        },
      },
      {
        audienceBusinessUnits: {
          some: {
            departments: {
              some: {
                isActive: true,
                memberships: { some: { userId, isActive: true } },
              },
            },
          },
        },
      },
      // Responsible People (Phase 2) — a direct row in its own relation,
      // never Project.audience. Same unconditional "every Project"
      // availability as the individual Audience check above.
      { responsiblePeople: { some: { id: userId } } },
    ],
  };
}
