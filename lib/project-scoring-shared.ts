/**
 * Pure Facilities Project Scoring math — the THE Excel formula and its
 * fixed Importance mapping, with NO Node/Prisma imports, so client
 * components (Create/Edit forms) can import the SAME values/functions
 * directly instead of duplicating them. Same split as lib/attachment-
 * constants.ts (pure) vs. lib/attachment-policy.ts (server-only,
 * re-exports + adds the Node-dependent pieces) — the one DB-touching
 * piece (getFacilitiesImportanceGroupCounts) lives in lib/services/
 * project-scoring-service.ts instead, which re-exports everything here
 * for a single server-side import point.
 */

/** 1 -> 10%, 2 -> 30%, 3 -> 60% — the fixed Importance Overall -> Importance Score mapping. Fractions (0.10/0.30/0.60), not whole percentages — formatScorePercent below is what renders a fraction as a "%" string. */
const IMPORTANCE_SCORE_FRACTION: Record<1 | 2 | 3, number> = { 1: 0.1, 2: 0.3, 3: 0.6 };

export const PROJECT_IMPORTANCE_OPTIONS = [1, 2, 3] as const;
export const PROJECT_SCORE_OPTIONS = [1, 2, 3, 4, 5] as const;

export function isValidImportance(value: number | null | undefined): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

/** Returns null for anything other than 1/2/3 — "Importance Score: Not set" rather than a silent wrong value. */
export function getImportanceScoreFraction(importanceOverall: number | null | undefined): number | null {
  return isValidImportance(importanceOverall) ? IMPORTANCE_SCORE_FRACTION[importanceOverall] : null;
}

export type FacilitiesImportanceGroupCounts = Partial<Record<1 | 2 | 3, number>>;

/**
 * THE Excel formula, preserved exactly, including its quirks:
 *   Score = (Importance Score × Project Score) / COUNT(same-Importance Facilities Projects)
 * Deliberately NOT divided by 5, NOT capped at 100%, NOT rounded here
 * (returns the full-precision fraction — e.g. 0.25 for 25% — formatting
 * for display is formatScorePercent's job, kept separate so every
 * consumer formats identically).
 *
 * Returns null ("Not set") when either required input is missing, or
 * when the group count for this Project's own Importance is 0/undefined
 * — which should only happen if `groupCounts` wasn't fetched against the
 * same dataset this Project is actually a member of (a caller bug, not a
 * real data state: a Project with a valid Importance Overall is always
 * counted in its own group by getFacilitiesImportanceGroupCounts).
 */
export function computeFacilitiesScorePercent(
  importanceOverall: number | null | undefined,
  projectScore: number | null | undefined,
  groupCounts: FacilitiesImportanceGroupCounts
): number | null {
  if (!isValidImportance(importanceOverall)) return null;
  if (projectScore === null || projectScore === undefined) return null;
  const importanceScore = IMPORTANCE_SCORE_FRACTION[importanceOverall];
  const groupCount = groupCounts[importanceOverall];
  if (!groupCount) return null;
  return (importanceScore * projectScore) / groupCount;
}

/** "Not set" / "25.00%" — the ONE formatter every surface (UI, export) uses, so the displayed precision can never disagree between them. */
export function formatScorePercent(fraction: number | null): string {
  if (fraction === null) return "Not set";
  return `${(fraction * 100).toFixed(2)}%`;
}
