import {
  resolveProjectTerminal,
  resolveActivityTerminal,
  getProjectTerminalConfigsForDepartments,
  getActivityTerminalConfigsForDepartments,
} from "@/lib/status-terminal";

/**
 * Single, central "overdue" concept shared by every surface (Projects/
 * Activities list+cards, Project Gantt, Resource Planning, the Projects
 * Dashboard, and any future one) — never re-derived per component. Overdue
 * is always DERIVED at read time from (dueDate, terminal-ness, now); no
 * `isOverdue` boolean is ever persisted, so it can never go stale.
 *
 * Timezone-safety: "the due date's day has fully elapsed" is defined purely
 * in UTC against the stored instant, independent of the server's or the
 * viewer's local timezone — two servers in different timezones (or a
 * server vs. a browser) must agree on the exact same overdue/not-overdue
 * boundary for the same stored dueDate and the same `now`. A date-only
 * value like "2026-07-20" is stored by Prisma as 2026-07-20T00:00:00.000Z
 * (UTC midnight) — this becomes overdue only once `now` reaches
 * 2026-07-21T00:00:00.000Z, i.e. after the ENTIRE UTC calendar day of the
 * due date has passed, never at its start.
 */
export function endOfDueDateUtc(dueDate: Date): Date {
  return new Date(Date.UTC(
    dueDate.getUTCFullYear(),
    dueDate.getUTCMonth(),
    dueDate.getUTCDate() + 1,
    0, 0, 0, 0
  ));
}

/**
 * Pure, deterministic core rule: overdue iff a dueDate exists, the item is
 * NOT terminal, and `now` is at/after the full elapse of the due date's UTC
 * day. A terminal item is never overdue regardless of how old its dueDate
 * is; an item with no dueDate is never overdue.
 */
export function isOverdue(dueDate: Date | null, isTerminal: boolean, now: Date = new Date()): boolean {
  if (!dueDate || isTerminal) return false;
  return now.getTime() >= endOfDueDateUtc(dueDate).getTime();
}

/**
 * `dueDate < startOfTodayUtc(now)` is the exact SQL-pushable equivalent of
 * `isOverdue(dueDate, false, now)` — i.e. "the due date's UTC calendar day
 * is strictly before today's" — proven equivalent to endOfDueDateUtc(dueDate)
 * <= now for every possible dueDate. Used to prefilter rows at the database
 * level (dashboard aggregate counts) before the (small, per department×status)
 * terminal-status resolution happens in code — never to replace isOverdue
 * itself, which remains the single source of truth for any per-row check.
 */
export function startOfTodayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

// ── Project / Activity wrappers ──────────────────────────────────────────
// Deliberately NOT "isProjectTerminalStatus(status)"-style helpers keyed
// only off the enum value — terminal-ness always requires a department
// (see lib/status-terminal.ts's resolveProjectTerminal/resolveActivityTerminal,
// which read real per-department config rows, never the status name alone).
// Callers resolve terminal-ness themselves via that module, then pass the
// already-resolved boolean in here.

/** For a single already-resolved terminal flag (e.g. computed via resolveProjectTerminal from a bulk-loaded config map). */
export function isProjectOverdue(dueDate: Date | null, isTerminal: boolean, now: Date = new Date()): boolean {
  return isOverdue(dueDate, isTerminal, now);
}

export function isActivityOverdue(dueDate: Date | null, isTerminal: boolean, now: Date = new Date()): boolean {
  return isOverdue(dueDate, isTerminal, now);
}

export { getProjectTerminalConfigsForDepartments, resolveProjectTerminal, getActivityTerminalConfigsForDepartments, resolveActivityTerminal };
