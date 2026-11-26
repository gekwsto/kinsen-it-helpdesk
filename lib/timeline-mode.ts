/**
 * Shared Actual / Expected timeline mode for Project Gantt
 * (/projects/gantt) and Resource Planning (/projects/resource-planning).
 *
 * The single place that decides WHICH stored date fields a timeline reads:
 *   - actual   → Project.startDate/endDate, ProjectActivity.startDate/dueDate
 *                (the pre-existing behaviour, unchanged)
 *   - expected → Project.expectedStartDate/expectedFinishDate,
 *                ProjectActivity.expectedStartDate/expectedFinishDate
 *
 * Expected mode NEVER falls back to Actual dates, and never infers a
 * Project's Expected dates from its Activities: a record missing the
 * Expected dates it needs simply resolves to null (→ "unscheduled").
 *
 * The mode travels in the URL (`?timeline=expected`; absent = actual, the
 * default) so the server can apply it to its own date-range filtering.
 */
export type TimelineMode = "actual" | "expected";

export const TIMELINE_MODES: readonly TimelineMode[] = ["actual", "expected"] as const;
export const DEFAULT_TIMELINE_MODE: TimelineMode = "actual";
/** URL search-param name carrying the mode. */
export const TIMELINE_MODE_PARAM = "timeline";

export const TIMELINE_MODE_LABEL: Record<TimelineMode, string> = {
  actual: "Actual",
  expected: "Expected",
};

/** Anything other than exactly "expected" is the default (actual) — an unknown value never switches modes. */
export function parseTimelineMode(value: string | string[] | null | undefined): TimelineMode {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "expected" ? "expected" : DEFAULT_TIMELINE_MODE;
}

export interface TimelineDates {
  start: Date | null;
  end: Date | null;
}

type ProjectDateFields = {
  startDate: Date | null;
  endDate: Date | null;
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
};

type ActivityDateFields = {
  startDate: Date | null;
  dueDate: Date | null;
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  isMilestone?: boolean;
};

/** A Project's own timeline dates in the given mode — never derived from its Activities. */
export function resolveProjectTimelineDates(p: ProjectDateFields, mode: TimelineMode): TimelineDates {
  return mode === "expected"
    ? { start: p.expectedStartDate, end: p.expectedFinishDate }
    : { start: p.startDate, end: p.endDate };
}

/**
 * Gantt dates for an Activity/Milestone. Milestone semantics are identical
 * in both modes: a single point at the mode's finish date (Actual: dueDate,
 * exactly as before; Expected: expectedFinishDate). A non-milestone
 * Activity uses the mode's own start/finish pair. The Gantt renders an item
 * only when BOTH resolved values are present — a missing Expected date
 * therefore lands in "Unscheduled", never a bar built from Actual dates.
 */
export function resolveGanttActivityDates(a: ActivityDateFields, mode: TimelineMode): TimelineDates {
  const start = mode === "expected" ? a.expectedStartDate : a.startDate;
  const end = mode === "expected" ? a.expectedFinishDate : a.dueDate;
  return a.isMilestone ? { start: end, end } : { start, end };
}

/**
 * Resource Planning dates for an Activity.
 *   - actual: the pre-existing behaviour exactly — a single missing side
 *     falls back to the other (a single-day estimate, `isFallbackDate`).
 *   - expected: BOTH Expected Start and Expected Finish are required; if
 *     either is missing the activity is unscheduled (start/end null). No
 *     single-day estimate and no Actual fallback.
 */
export function resolveResourcePlanningActivityDates(
  a: ActivityDateFields,
  mode: TimelineMode
): TimelineDates & { isFallbackDate: boolean } {
  if (mode === "expected") {
    return a.expectedStartDate && a.expectedFinishDate
      ? { start: a.expectedStartDate, end: a.expectedFinishDate, isFallbackDate: false }
      : { start: null, end: null, isFallbackDate: false };
  }
  return {
    start: a.startDate ?? a.dueDate,
    end: a.dueDate ?? a.startDate,
    isFallbackDate: !a.startDate || !a.dueDate,
  };
}

/** Prisma field names of a Project's timeline dates in the given mode. */
export function projectTimelineFields(mode: TimelineMode): { start: "startDate" | "expectedStartDate"; end: "endDate" | "expectedFinishDate" } {
  return mode === "expected" ? { start: "expectedStartDate", end: "expectedFinishDate" } : { start: "startDate", end: "endDate" };
}

/** Prisma field names of an Activity's timeline dates in the given mode. */
export function activityTimelineFields(mode: TimelineMode): { start: "startDate" | "expectedStartDate"; end: "dueDate" | "expectedFinishDate" } {
  return mode === "expected" ? { start: "expectedStartDate", end: "expectedFinishDate" } : { start: "startDate", end: "dueDate" };
}

/**
 * Project Gantt's server-side ?from=/?to= filter, on the selected mode's own
 * Project date fields — interval overlap:
 *
 *     start <= rangeEnd  AND  end >= rangeStart
 *
 * so a Project spanning the whole selected range is included (the previous
 * "start in range OR end in range" rule missed it).
 *   - Open-ended filter: only the supplied bound is compared (from only →
 *     end >= from; to only → start <= to).
 *   - Missing dates: the Gantt's own contract draws a Project bar only when
 *     BOTH its start and end exist (otherwise it is "unscheduled"), so while
 *     a range filter is active a Project must have both dates in the
 *     selected mode — a half-dated or undated Project is never reported as
 *     being "in" a range it has no interval for. In Expected mode this
 *     never consults Actual dates, and never Activity dates.
 *   - Milestones are Activities, not Projects; this filter selects Projects
 *     (their Activities/milestones render under any matching Project, as
 *     before).
 * Invalid dates are ignored (treated as not supplied). Returns null when no
 * usable bound is requested.
 */
export function buildProjectTimelineRangeWhere(
  mode: TimelineMode,
  from: Date | null,
  to: Date | null
): Record<string, unknown> | null {
  const rangeStart = from && !Number.isNaN(from.getTime()) ? from : null;
  const rangeEnd = to && !Number.isNaN(to.getTime()) ? to : null;
  if (!rangeStart && !rangeEnd) return null;
  const f = projectTimelineFields(mode);
  return {
    AND: [
      { [f.start]: rangeEnd ? { lte: rangeEnd } : { not: null } },
      { [f.end]: rangeStart ? { gte: rangeStart } : { not: null } },
    ],
  };
}

/** What a timeline drag is moving — selects which stored fields a move writes. */
export type SchedulingTarget = "project" | "activity" | "milestone";

/**
 * The PATCH body a drag-to-reschedule sends (PATCH /api/projects/[id] or
 * PATCH /api/activities/[id]) — the ONE mapping both Project Gantt and
 * Resource Planning use, so a move only ever writes the selected mode's
 * own fields: Actual never touches Expected dates, Expected never touches
 * Actual dates, and nothing synchronises the two.
 *
 *   mode      project                                activity                                milestone
 *   actual    startDate, endDate                     startDate, dueDate                      startDate = dueDate = date   (unchanged)
 *   expected  expectedStartDate, expectedFinishDate  expectedStartDate, expectedFinishDate   expectedFinishDate (+ expectedStartDate only if it already exists)
 *
 * Callers pass values already shifted with lib/date-only.ts's shiftDateOnly
 * (canonical UTC-midnight date-only ISO strings); a whole-bar move shifts
 * start and finish by the same calendar-day delta, preserving duration.
 *
 * Expected milestone: `start` is the milestone's EXISTING Expected Start
 * shifted by the same delta, or null when it has none — it is then omitted,
 * so a missing Expected Start is never created. Shifting both together
 * keeps start <= finish, so a valid milestone moves freely in either
 * direction. (Actual milestones keep their existing startDate = dueDate.)
 *
 * Server-side authorization, date validation (finish >= start) and
 * Expected-duration recalculation all stay in the existing routes.
 */
export function buildSchedulingPatch(
  target: SchedulingTarget,
  mode: TimelineMode,
  start: string | null,
  end: string
): Record<string, string> {
  if (mode === "expected") {
    if (target === "milestone") return start ? { expectedStartDate: start, expectedFinishDate: end } : { expectedFinishDate: end };
    return { expectedStartDate: start ?? end, expectedFinishDate: end };
  }
  if (target === "milestone") return { startDate: end, dueDate: end };
  if (target === "project") return { startDate: start ?? end, endDate: end };
  return { startDate: start ?? end, dueDate: end };
}
