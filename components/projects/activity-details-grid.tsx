import { formatDate } from "@/lib/utils";

export interface ActivityDetailsGridFields {
  owner?: { id: string; name: string | null; image: string | null } | null;
  dueDate: string | null;
  /** Also drives the same-day-start warning in ProjectActivitySequenceCard — displayed here too since it's the planning baseline a user scanning a row would want alongside it. */
  expectedStartDate: string | null;
  expectedFinishDate: string | null;
  /** Whole calendar days, already computed/stored server-side — never recalculated here. */
  expectedDays: number | null;
  /** The legacy, editable "real" start date (ProjectActivity.startDate) — distinct from expectedStartDate (the request-origin planning baseline). */
  startDate: string | null;
  /** Stamped server-side exactly at the authoritative COMPLETED transition — null until the Activity is actually completed, never a stand-in for expectedFinishDate. */
  completedAt: string | null;
  actualDays: number | null;
}

/**
 * The Activity row "Details" level shared by both ProjectActivitiesCard and
 * ProjectActivitySequenceCard — one place deciding which of Owner/Due/
 * Expected.../Actual... fields actually apply to a given row (never
 * duplicated per card), rendered as a responsive labeled grid instead of the
 * previous single line of "Label: value" text. Returns null when no field
 * applies (never renders an empty grid/border).
 */
export function ActivityDetailsGrid({ owner, dueDate, expectedStartDate, expectedFinishDate, expectedDays, startDate, completedAt, actualDays }: ActivityDetailsGridFields) {
  const fields: { label: string; value: string }[] = [];
  if (owner) fields.push({ label: "Owner", value: owner.name ?? "—" });
  if (dueDate) fields.push({ label: "Due Date", value: formatDate(dueDate) });
  if (expectedStartDate) fields.push({ label: "Expected Start", value: formatDate(expectedStartDate) });
  if (expectedFinishDate) fields.push({ label: "Expected Finish", value: formatDate(expectedFinishDate) });
  if (typeof expectedDays === "number") fields.push({ label: "Expected Duration", value: `${expectedDays} day(s)` });
  if (startDate) fields.push({ label: "Actual Start", value: formatDate(startDate) });
  if (completedAt) fields.push({ label: "Actual Finish", value: formatDate(completedAt) });
  if (typeof actualDays === "number") fields.push({ label: "Actual Duration", value: `${actualDays} day(s)` });

  if (fields.length === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-1.5 pt-2 mt-1 border-t">
      {fields.map((f) => (
        <div key={f.label} className="min-w-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{f.label}</p>
          <p className="text-xs font-medium truncate" title={f.value}>
            {f.value}
          </p>
        </div>
      ))}
    </div>
  );
}
