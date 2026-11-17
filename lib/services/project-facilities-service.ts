/**
 * Facilities Services-only Project metadata — the single place that
 * resolves the Facilities Services Department's canonical id (by slug,
 * never by display name), turns a Start/End input (either an exact date or
 * a Quarter+Year pair) into the actual values persisted, and decides
 * whether a given write is even allowed. Every Project creation/edit path
 * (POST /api/projects, PATCH /api/projects/[id],
 * createProjectFromApprovedRequest) calls through here — none of them
 * re-derive this logic themselves.
 */
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { ProjectDatePrecision, ProjectQuarter } from "@prisma/client";

// Same "well-known department, resolved by slug, never by name, overridable
// via env for a different environment" pattern as
// DEFAULT_LEGACY_DEPARTMENT_SLUG in lib/services/department-service.ts.
// Confirmed against the real production department list (exactly one
// "Facilities Services" row, slug "facilities-services", Active) — not a
// guess.
const FACILITIES_SERVICES_DEPARTMENT_SLUG = process.env.FACILITIES_SERVICES_DEPARTMENT_SLUG || "facilities-services";

export const getFacilitiesServicesDepartmentId = cache(async (): Promise<string | null> => {
  const department = await prisma.department.findUnique({
    where: { slug: FACILITIES_SERVICES_DEPARTMENT_SLUG },
    select: { id: true },
  });
  return department?.id ?? null;
});

const QUARTER_START_MONTH: Record<ProjectQuarter, number> = { Q1: 0, Q2: 3, Q3: 6, Q4: 9 };

/** First calendar day of (quarter, year), UTC midnight — same date-only convention as lib/date-only.ts. */
export function quarterStartDate(quarter: ProjectQuarter, year: number): Date {
  return new Date(Date.UTC(year, QUARTER_START_MONTH[quarter], 1));
}

/** Last calendar day of (quarter, year), UTC midnight — day 0 of the month after the quarter's last month. */
export function quarterEndDate(quarter: ProjectQuarter, year: number): Date {
  return new Date(Date.UTC(year, QUARTER_START_MONTH[quarter] + 3, 0));
}

/** "Q2 2027" — the one place this label is formatted, reused by both the Project Overview UI and the Excel export so they can never disagree. */
export function formatFacilitiesQuarterLabel(quarter: ProjectQuarter | null, year: number | null): string | null {
  if (!quarter || !year) return null;
  return `${quarter} ${year}`;
}

const FACILITIES_FIELD_KEYS = [
  "facilitiesCompany",
  "facilitiesLocation",
  "facilitiesStartPrecision",
  "facilitiesStartQuarter",
  "facilitiesStartYear",
  "facilitiesEndPrecision",
  "facilitiesEndQuarter",
  "facilitiesEndYear",
] as const;

/**
 * True iff ANY of the 8 Facilities-only keys is actually present (even as
 * an explicit null) in a raw request body — checked against the RAW body,
 * not the Zod-parsed result, so this still catches an attempt even if the
 * value itself would otherwise fail validation. The one gate every write
 * path uses to reject a Facilities-field write for a Project outside the
 * Facilities Services workspace (requirement: "prevent unauthorized
 * changes" to this metadata once a Project has left that workspace, or for
 * one that was never in it).
 */
export function hasFacilitiesFieldsPresent(body: Record<string, unknown>): boolean {
  return FACILITIES_FIELD_KEYS.some((key) => body[key] !== undefined);
}

export type FacilitiesResolutionError =
  | { code: "quarter_fields_incomplete"; field: "start" | "end" }
  | { code: "exact_date_required"; field: "start" | "end" }
  | { code: "invalid_date_range" };

export function facilitiesResolutionErrorMessage(error: FacilitiesResolutionError): string {
  switch (error.code) {
    case "quarter_fields_incomplete":
      return `Select both a Quarter and a Year for ${error.field === "start" ? "Start" : "End"}.`;
    case "exact_date_required":
      return `Enter an exact ${error.field === "start" ? "Start" : "End"} date.`;
    case "invalid_date_range":
      return "Start must not be later than End.";
  }
}

export interface ResolvedFacilitiesWrite {
  facilitiesStartPrecision: ProjectDatePrecision | null;
  facilitiesStartQuarter: ProjectQuarter | null;
  facilitiesStartYear: number | null;
  facilitiesEndPrecision: ProjectDatePrecision | null;
  facilitiesEndQuarter: ProjectQuarter | null;
  facilitiesEndYear: number | null;
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * THE one place that turns a Facilities Services Project's Start/End
 * inputs into what's actually persisted. `effective` values are whatever
 * the CALLER has already merged with the existing stored row (so a PATCH
 * touching only one field doesn't silently blank the other) — this
 * function has no notion of "existing", it only resolves one complete pair
 * of inputs into one complete pair of outputs.
 *
 * QUARTER precision requires both quarter and year (rejected otherwise);
 * the resulting boundary is the derived startDate/endDate every existing
 * Gantt/filter/overdue/export consumer already reads unchanged. Any
 * precision other than QUARTER (EXACT, or unset) uses the plain exact-date
 * string as-is — identical to this app's existing, unmodified Project date
 * behavior — and explicitly clears quarter/year back to null, so a stale
 * quarter selection from a PREVIOUS edit can never linger once the user
 * switches back to an exact date.
 *
 * `switchedAwayFromQuarter` (edit only — a create has no "existing" to
 * switch away FROM) flags that THIS request is moving a field's precision
 * from QUARTER to something else: in that case `startExact`/`endExact`
 * must be a genuinely NEW value supplied in THIS same request, never a
 * fallback to the Project's existing (quarter-derived) startDate/endDate —
 * otherwise the old quarter boundary would get silently re-persisted as
 * if the user had just typed it in as an exact date, which is exactly the
 * "never let a quarter boundary be mistaken for a user-entered exact
 * date" rule this feature exists to prevent.
 */
export function resolveFacilitiesWrite(effective: {
  startPrecision: ProjectDatePrecision | null;
  startQuarter: ProjectQuarter | null;
  startYear: number | null;
  startExact: string | null;
  endPrecision: ProjectDatePrecision | null;
  endQuarter: ProjectQuarter | null;
  endYear: number | null;
  endExact: string | null;
  switchedAwayFromQuarter?: { start: boolean; end: boolean };
}): { ok: true; value: ResolvedFacilitiesWrite } | { ok: false; error: FacilitiesResolutionError } {
  let startDate: Date | null;
  let startQuarter = effective.startQuarter;
  let startYear = effective.startYear;
  if (effective.startPrecision === ProjectDatePrecision.QUARTER) {
    if (!startQuarter || !startYear) return { ok: false, error: { code: "quarter_fields_incomplete", field: "start" } };
    startDate = quarterStartDate(startQuarter, startYear);
  } else {
    if (effective.switchedAwayFromQuarter?.start && !effective.startExact) {
      return { ok: false, error: { code: "exact_date_required", field: "start" } };
    }
    startDate = effective.startExact ? new Date(effective.startExact) : null;
    startQuarter = null;
    startYear = null;
  }

  let endDate: Date | null;
  let endQuarter = effective.endQuarter;
  let endYear = effective.endYear;
  if (effective.endPrecision === ProjectDatePrecision.QUARTER) {
    if (!endQuarter || !endYear) return { ok: false, error: { code: "quarter_fields_incomplete", field: "end" } };
    endDate = quarterEndDate(endQuarter, endYear);
  } else {
    if (effective.switchedAwayFromQuarter?.end && !effective.endExact) {
      return { ok: false, error: { code: "exact_date_required", field: "end" } };
    }
    endDate = effective.endExact ? new Date(effective.endExact) : null;
    endQuarter = null;
    endYear = null;
  }

  // Requirement: "Start must not be later than End." Checked against the
  // RESOLVED boundary dates, so a Quarter Start vs. an Exact End (or any
  // other combination) is validated consistently — the same rule a plain
  // Project in any other workspace simply never has (preserved unchanged
  // there; this check only ever runs for a Facilities Services write).
  if (startDate && endDate && startDate > endDate) {
    return { ok: false, error: { code: "invalid_date_range" } };
  }

  return {
    ok: true,
    value: {
      facilitiesStartPrecision: effective.startPrecision,
      facilitiesStartQuarter: startQuarter,
      facilitiesStartYear: startYear,
      facilitiesEndPrecision: effective.endPrecision,
      facilitiesEndQuarter: endQuarter,
      facilitiesEndYear: endYear,
      startDate,
      endDate,
    },
  };
}
