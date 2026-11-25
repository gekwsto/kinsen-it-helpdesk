/**
 * Working-day duration backfill — PLANNING (pure, no writes).
 *
 * Decides, record by record, whether a stored duration is a DATE-DERIVED
 * value produced by the former calendar-day rule (-> convert to working
 * days with the canonical lib/date-only.ts calculation), a value that is
 * already in working days (-> no-op, which is what makes the backfill
 * idempotent), an explicit/manual value (-> preserve), or a value whose
 * provenance cannot be established (-> preserve and report separately).
 * The SAME plan drives the read-only report and the transactional apply.
 *
 * Provenance evidence (never origin alone):
 *   - The ONLY code paths that ever wrote these columns derived them from
 *     the record's own dates (request conversion, POST/PATCH projects,
 *     historical import, the Activity routes, migration 20261125120000) or
 *     clamped a negative actualDays to 0 (migration 20261005114249). None
 *     ever stored an externally supplied total; a historical import's
 *     source "Total Days" lives only in
 *     ProjectRequest.historicalSourceMetadata.originalTotalDays.
 *   - So a stored value is proven date-derived when it EQUALS the former
 *     calendar-day derivation of the record's CURRENT dates. Anything else
 *     (dates edited since, dates cleared, unknown origin) is unverifiable.
 *   - A historical-import Project whose stored value coincides with the
 *     explicitly supplied source total is treated as ambiguous and
 *     preserved, even if it also matches the calendar derivation.
 *   - Project durations with …Overridden = true are explicit manual values.
 *
 * legacyCalendarDays below exists ONLY as provenance evidence for this
 * one-off transition — it is not a duration calculation used anywhere in
 * the application (which uses lib/date-only.ts exclusively).
 */
import { calculateWorkingDays, actualDaysFromCompletion } from "@/lib/date-only";

export const BACKFILL_KIND = "working-days-v1";

/** The FORMER rule (finish - start, whole UTC calendar days). Evidence only — see module doc. */
export function legacyCalendarDays(start: Date | null | undefined, finish: Date | null | undefined): number | null {
  if (!start || !finish) return null;
  const a = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const b = Date.UTC(finish.getUTCFullYear(), finish.getUTCMonth(), finish.getUTCDate());
  return Math.round((b - a) / 86400000);
}

export type Category =
  | "CONVERT" // proven calendar-derived -> working days
  | "FILL_MISSING" // automatic, value null, both dates present -> working days
  | "ALREADY_WORKING" // already equals the working-day value -> no-op
  | "PRESERVE_MANUAL" // explicit manual override -> untouched
  | "PRESERVE_AMBIGUOUS_SOURCE_TOTAL" // equals the import's explicit source total -> untouched (Project: protected)
  | "PRESERVE_UNVERIFIED" // provenance cannot be established -> untouched (Project: protected)
  | "EMPTY" // null and nothing to derive
  | "NOT_COMPLETED_NO_ACTUAL"; // Activity actualDays null (never fabricated)

export type Entity = "Project" | "ProjectActivity";
export type Field = "expectedTotalInitialDays" | "actualTotalDays" | "expectedDays" | "actualDays";

export interface PlannedField {
  entity: Entity;
  recordId: string;
  field: Field;
  category: Category;
  oldValue: number | null;
  newValue: number | null;
  /** Project durations only. */
  oldOverridden?: boolean;
  newOverridden?: boolean;
  /** True when this plan entry writes anything (value and/or override flag). */
  writes: boolean;
  note?: string;
}

export interface ProjectInput {
  id: string;
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  expectedTotalInitialDays: number | null;
  expectedTotalInitialDaysOverridden: boolean;
  startDate: Date | null;
  endDate: Date | null;
  actualTotalDays: number | null;
  actualTotalDaysOverridden: boolean;
  /** historicalSourceMetadata.originalTotalDays of the originating import request, if any. */
  sourceTotalDays: number | null;
}

export interface ActivityInput {
  id: string;
  expectedStartDate: Date | null;
  expectedFinishDate: Date | null;
  expectedDays: number | null;
  startDate: Date | null;
  completedAt: Date | null;
  actualDays: number | null;
}

function planProjectField(p: ProjectInput, field: "expectedTotalInitialDays" | "actualTotalDays"): PlannedField {
  const isExpected = field === "expectedTotalInitialDays";
  const value = isExpected ? p.expectedTotalInitialDays : p.actualTotalDays;
  const overridden = isExpected ? p.expectedTotalInitialDaysOverridden : p.actualTotalDaysOverridden;
  const start = isExpected ? p.expectedStartDate : p.startDate;
  const finish = isExpected ? p.expectedFinishDate : p.endDate;
  const base = { entity: "Project" as const, recordId: p.id, field, oldValue: value, oldOverridden: overridden };
  const keep = (category: Category, note?: string): PlannedField => ({ ...base, category, newValue: value, newOverridden: overridden, writes: false, note });
  // Preserve the VALUE, and mark it manual so it can never be silently
  // recalculated by a later date edit and so every view (edit page in
  // automatic mode would otherwise show the date-derived number) shows the
  // stored value consistently. Fully reversible via rollback.
  const protect = (category: Category, note: string): PlannedField => ({ ...base, category, newValue: value, newOverridden: true, writes: true, note });

  if (overridden) return keep("PRESERVE_MANUAL");
  const working = calculateWorkingDays(start, finish);
  if (value === null) {
    return working === null ? keep("EMPTY") : { ...base, category: "FILL_MISSING", newValue: working, newOverridden: false, writes: true };
  }
  if (working === null) return protect("PRESERVE_UNVERIFIED", "dates missing/invalid — value cannot be derived from them");
  if (value === working) return keep("ALREADY_WORKING");
  if (p.sourceTotalDays !== null && value === p.sourceTotalDays) {
    return protect("PRESERVE_AMBIGUOUS_SOURCE_TOTAL", `equals the import's explicitly supplied source total (${p.sourceTotalDays})`);
  }
  if (value === legacyCalendarDays(start, finish)) return { ...base, category: "CONVERT", newValue: working, newOverridden: false, writes: true };
  return protect("PRESERVE_UNVERIFIED", `stored ${value} matches neither calendar (${legacyCalendarDays(start, finish)}) nor working (${working}) days of the current dates`);
}

function planActivityExpected(a: ActivityInput): PlannedField {
  const base = { entity: "ProjectActivity" as const, recordId: a.id, field: "expectedDays" as const, oldValue: a.expectedDays };
  const keep = (category: Category, note?: string): PlannedField => ({ ...base, category, newValue: a.expectedDays, writes: false, note });
  const working = calculateWorkingDays(a.expectedStartDate, a.expectedFinishDate);
  if (a.expectedDays === null) return working === null ? keep("EMPTY") : { ...base, category: "FILL_MISSING", newValue: working, writes: true };
  if (working === null) return keep("PRESERVE_UNVERIFIED", "expected dates missing/invalid");
  if (a.expectedDays === working) return keep("ALREADY_WORKING");
  if (a.expectedDays === legacyCalendarDays(a.expectedStartDate, a.expectedFinishDate)) return { ...base, category: "CONVERT", newValue: working, writes: true };
  return keep("PRESERVE_UNVERIFIED", `stored ${a.expectedDays} matches neither calendar nor working days of the current dates`);
}

function planActivityActual(a: ActivityInput): PlannedField {
  const base = { entity: "ProjectActivity" as const, recordId: a.id, field: "actualDays" as const, oldValue: a.actualDays };
  const keep = (category: Category, note?: string): PlannedField => ({ ...base, category, newValue: a.actualDays, writes: false, note });
  // Never fabricated: a null actualDays (not completed, or completed under
  // a rule that produced none) stays null — filling it would CREATE a new
  // actual cost rather than convert an existing one.
  if (a.actualDays === null) return keep("NOT_COMPLETED_NO_ACTUAL");
  // The exact reference rule used at completion: Expected Start, else Actual Start.
  const ref = a.expectedStartDate ?? a.startDate;
  if (!ref || !a.completedAt) return keep("PRESERVE_UNVERIFIED", "no start reference or completion timestamp");
  const working = actualDaysFromCompletion(ref, a.completedAt);
  if (a.actualDays === working) return keep("ALREADY_WORKING");
  const calendar = Math.max(0, legacyCalendarDays(ref, a.completedAt)!);
  if (a.actualDays === calendar) return { ...base, category: "CONVERT", newValue: working, writes: true };
  return keep("PRESERVE_UNVERIFIED", `stored ${a.actualDays} != calendar (${calendar}) / working (${working}) from the current start reference — likely edited after completion`);
}

export function planProject(p: ProjectInput): PlannedField[] {
  return [planProjectField(p, "expectedTotalInitialDays"), planProjectField(p, "actualTotalDays")];
}

export function planActivity(a: ActivityInput): PlannedField[] {
  return [planActivityExpected(a), planActivityActual(a)];
}
