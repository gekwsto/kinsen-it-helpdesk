/**
 * The ONE canonical implementation of Facilities Project Scoring — every
 * surface that shows or exports a Score (Project Overview, the Projects
 * list, the standalone Excel list export, the single-Project Excel
 * export) calls through here, never re-deriving the formula itself.
 *
 * ONLY `facilitiesProjectImportanceOverall` and `facilitiesProjectScore`
 * are persisted (Project columns, both nullable). Everything else —
 * Importance Score (the 10/30/60% mapping) and Score (the Excel formula
 * result) — is computed FRESH on every read, never stored. This is a
 * deliberate consequence of the "recalculate automatically on create/
 * delete/reassign/importance-change" requirement: a derived value with
 * nothing to invalidate is always correct by construction, unlike a
 * materialized one that would need an explicit recompute trigger wired
 * into every mutation path that could affect it.
 *
 * Re-exports the pure formula/constants from lib/project-scoring-
 * shared.ts (which has no Node/Prisma imports, so client components can
 * import that file directly) alongside the one DB-touching piece this
 * server-only file adds: getFacilitiesImportanceGroupCounts() — a single
 * grouped COUNT across the whole Facilities Services dataset, run ONCE
 * per request/page by the caller (never once per Project). Every
 * per-Project computation after that (computeFacilitiesScorePercent) is
 * pure, synchronous arithmetic against that already-fetched map.
 */
import { prisma } from "@/lib/prisma";
import { getFacilitiesServicesDepartmentId } from "@/lib/services/project-facilities-service";
import { isValidImportance, type FacilitiesImportanceGroupCounts } from "@/lib/project-scoring-shared";

export {
  PROJECT_IMPORTANCE_OPTIONS,
  PROJECT_SCORE_OPTIONS,
  getImportanceScoreFraction,
  computeFacilitiesScorePercent,
  formatScorePercent,
  type FacilitiesImportanceGroupCounts,
} from "@/lib/project-scoring-shared";

/**
 * ONE grouped query, covering every status (Completed/Cancelled/On Hold/
 * Planning/etc. all included — no `status` filter at all) across the
 * WHOLE Facilities Services dataset, never the current user's visible
 * set, workspace selection, filters, or page. A Project with no
 * Importance Overall set is excluded from every group's count (it isn't
 * a member of any group), matching "exclude projects without a valid
 * Importance Overall from the corresponding group count."
 *
 * Returns {} (every group effectively 0/undefined) if the Facilities
 * Services department itself can't be resolved — callers already treat a
 * missing count the same as "Not set" via computeFacilitiesScorePercent.
 */
export async function getFacilitiesImportanceGroupCounts(): Promise<FacilitiesImportanceGroupCounts> {
  const facilitiesServicesDepartmentId = await getFacilitiesServicesDepartmentId();
  if (!facilitiesServicesDepartmentId) return {};

  const groups = await prisma.project.groupBy({
    by: ["facilitiesProjectImportanceOverall"],
    where: {
      departmentId: facilitiesServicesDepartmentId,
      facilitiesProjectImportanceOverall: { not: null },
    },
    _count: { _all: true },
  });

  const counts: FacilitiesImportanceGroupCounts = {};
  for (const g of groups) {
    if (isValidImportance(g.facilitiesProjectImportanceOverall)) {
      counts[g.facilitiesProjectImportanceOverall] = g._count._all;
    }
  }
  return counts;
}
