/**
 * Pure (no Prisma/server-only imports) definition of the admin-configurable
 * Mention Reminder delay: the single source of the default, the safe bounds
 * and the numeric-duration+unit parsing — so 24 hours is never hardcoded
 * anywhere else. Storage is one normalized integer of MINUTES
 * (MentionReminderSettings.delayMinutes; the migration's CHECK constraint
 * mirrors the bounds below).
 */
export const DEFAULT_MENTION_REMINDER_DELAY_MINUTES = 24 * 60;
export const MIN_MENTION_REMINDER_DELAY_MINUTES = 5;
export const MAX_MENTION_REMINDER_DELAY_MINUTES = 30 * 24 * 60;

export const MENTION_REMINDER_UNITS = ["minutes", "hours", "days"] as const;
export type MentionReminderUnit = (typeof MENTION_REMINDER_UNITS)[number];

const MINUTES_PER_UNIT: Record<MentionReminderUnit, number> = { minutes: 1, hours: 60, days: 24 * 60 };

export type ParsedDelay = { ok: true; minutes: number } | { ok: false; error: string };

export function parseMentionReminderDelay(value: unknown, unit: unknown): ParsedDelay {
  if (typeof unit !== "string" || !(MENTION_REMINDER_UNITS as readonly string[]).includes(unit)) {
    return { ok: false, error: "Unit must be minutes, hours or days." };
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: "Reminder delay must be a positive whole number." };
  }
  const minutes = value * MINUTES_PER_UNIT[unit as MentionReminderUnit];
  if (minutes < MIN_MENTION_REMINDER_DELAY_MINUTES || minutes > MAX_MENTION_REMINDER_DELAY_MINUTES) {
    return { ok: false, error: "Reminder delay must be between 5 minutes and 30 days." };
  }
  return { ok: true, minutes };
}

/** Largest unit that divides the stored minutes evenly — for display/editing only. */
export function describeMentionReminderDelay(minutes: number): { value: number; unit: MentionReminderUnit } {
  if (minutes % MINUTES_PER_UNIT.days === 0) return { value: minutes / MINUTES_PER_UNIT.days, unit: "days" };
  if (minutes % MINUTES_PER_UNIT.hours === 0) return { value: minutes / MINUTES_PER_UNIT.hours, unit: "hours" };
  return { value: minutes, unit: "minutes" };
}
