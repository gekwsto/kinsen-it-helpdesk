import { ActivityPriority } from "@prisma/client";

/**
 * Canonical urgency ranking for ActivityPriority — single source of truth
 * for any "most critical first" ordering (Resource Planning's timeline rows
 * today; any future Gantt/list priority sort should reuse this too, rather
 * than re-deriving it locally).
 *
 * Deliberately NOT the enum's own declaration order used as a rank directly
 * — LOW/MEDIUM/HIGH/URGENT is ascending by design (matches how Postgres
 * orders the native enum type), so `ORDER BY priority DESC` already yields
 * URGENT-first at the database level, but any comparator written in
 * TypeScript needs this explicit map since JS has no notion of "the enum's
 * declared order" at runtime.
 */
export const ACTIVITY_PRIORITY_RANK: Record<ActivityPriority, number> = {
  [ActivityPriority.URGENT]: 3,
  [ActivityPriority.HIGH]: 2,
  [ActivityPriority.MEDIUM]: 1,
  [ActivityPriority.LOW]: 0,
};

/** Human label for a priority value — matches the wording already used in the Activities list / new-activity form's own priority UI. */
export const ACTIVITY_PRIORITY_LABEL: Record<ActivityPriority, string> = {
  [ActivityPriority.URGENT]: "Urgent",
  [ActivityPriority.HIGH]: "High",
  [ActivityPriority.MEDIUM]: "Medium",
  [ActivityPriority.LOW]: "Low",
};

/**
 * Rank for a priority value that may have widened to a plain `string` at an
 * API/type boundary (e.g. ResourceEvent.priority) — unknown/missing values
 * rank below LOW (sort last), never thrown on.
 */
export function activityPriorityRank(priority: string | null | undefined): number {
  if (!priority) return -1;
  return ACTIVITY_PRIORITY_RANK[priority as ActivityPriority] ?? -1;
}

/** Descending-urgency comparator: URGENT, HIGH, MEDIUM, LOW, then unknown/missing last. */
export function comparePriorityDesc(a: string | null | undefined, b: string | null | undefined): number {
  return activityPriorityRank(b) - activityPriorityRank(a);
}
