/**
 * Ticket Resolution Time — the single shared conversion/formatting/
 * validation module for the MANUAL effort recorded on a ticket
 * (Ticket.resolutionTimeMinutes). Client- and server-safe (no Node/DB
 * imports).
 *
 * Fixed business rule (not a calendar): 1 day = 8 working hours = 480
 * minutes, 1 hour = 60 minutes. No weekends, holidays, business calendars
 * or SLA rules are ever applied. Nothing here derives a duration from
 * timestamps — the value is only ever what a user typed.
 *
 * NULL means "not recorded" and is always kept distinct from an explicitly
 * recorded 0.
 */
import { z } from "zod";

export const MINUTES_PER_HOUR = 60;
export const WORKING_HOURS_PER_DAY = 8;
export const MINUTES_PER_WORKING_DAY = WORKING_HOURS_PER_DAY * MINUTES_PER_HOUR; // 480
/** Upper bound (1000 working days) — also enforced by a DB CHECK constraint. */
export const MAX_RESOLUTION_TIME_MINUTES = 1000 * MINUTES_PER_WORKING_DAY; // 480000

export interface DurationParts {
  days: number;
  hours: number;
  minutes: number;
}

/** totalMinutes = days*480 + hours*60 + minutes. */
export function durationPartsToMinutes({ days, hours, minutes }: DurationParts): number {
  return days * MINUTES_PER_WORKING_DAY + hours * MINUTES_PER_HOUR + minutes;
}

/** Normalized against the 8-hour working day (e.g. 600 -> 1d 2h 0m). */
export function minutesToDurationParts(total: number): DurationParts {
  const days = Math.floor(total / MINUTES_PER_WORKING_DAY);
  const rest = total - days * MINUTES_PER_WORKING_DAY;
  const hours = Math.floor(rest / MINUTES_PER_HOUR);
  return { days, hours, minutes: rest - hours * MINUTES_PER_HOUR };
}

export const RESOLUTION_TIME_NOT_RECORDED = "Not recorded";

/** "1d 2h 30m", "2h 15m", "45m", "0m", or "Not recorded" for NULL. */
export function formatResolutionTime(total: number | null | undefined): string {
  if (total === null || total === undefined) return RESOLUTION_TIME_NOT_RECORDED;
  const { days, hours, minutes } = minutesToDurationParts(total);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

/** The three dialog inputs as raw strings ("" = left empty). */
export interface DurationInputs {
  days: string;
  hours: string;
  minutes: string;
}

export const EMPTY_DURATION_INPUTS: DurationInputs = { days: "", hours: "", minutes: "" };

/** Prefill: NULL -> all empty; otherwise the normalized parts (zeros shown as "0"). */
export function minutesToDurationInputs(total: number | null | undefined): DurationInputs {
  if (total === null || total === undefined) return EMPTY_DURATION_INPUTS;
  const { days, hours, minutes } = minutesToDurationParts(total);
  return { days: String(days), hours: String(hours), minutes: String(minutes) };
}

export type DurationInputsResult = { ok: true; minutes: number | null } | { ok: false; error: string };

/**
 * All three empty -> NULL. Otherwise empty fields count as 0. Each field
 * must be a non-negative whole number and the total must not exceed
 * MAX_RESOLUTION_TIME_MINUTES.
 */
export function parseDurationInputs(inputs: DurationInputs): DurationInputsResult {
  const raw = [inputs.days, inputs.hours, inputs.minutes].map((v) => v.trim());
  if (raw.every((v) => v === "")) return { ok: true, minutes: null };
  const nums: number[] = [];
  for (const v of raw) {
    if (v === "") {
      nums.push(0);
      continue;
    }
    if (!/^\d+$/.test(v)) return { ok: false, error: "Use whole, non-negative numbers only." };
    nums.push(Number(v));
  }
  const total = durationPartsToMinutes({ days: nums[0], hours: nums[1], minutes: nums[2] });
  if (!Number.isSafeInteger(total) || total > MAX_RESOLUTION_TIME_MINUTES) {
    return { ok: false, error: `Resolution time cannot exceed ${MAX_RESOLUTION_TIME_MINUTES / MINUTES_PER_WORKING_DAY} working days.` };
  }
  return { ok: true, minutes: total };
}

/** API value: total minutes, or explicit null to clear. */
export const resolutionTimeMinutesSchema = z
  .number()
  .int("Resolution time must be a whole number of minutes")
  .min(0, "Resolution time cannot be negative")
  .max(MAX_RESOLUTION_TIME_MINUTES, "Resolution time is too large")
  .nullable();

/**
 * "Resolved" has no canonical flag in this data model (TicketStatus is a
 * per-department table) — the existing convention (ticket detail Resolve
 * action, dashboard) is the status literally named "Resolved". Centralized
 * here so the UI and the API agree on what counts as a resolution.
 */
export const RESOLVED_STATUS_NAME = "Resolved";
export function isResolutionStatus(status: { name: string } | null | undefined): boolean {
  return status?.name === RESOLVED_STATUS_NAME;
}
