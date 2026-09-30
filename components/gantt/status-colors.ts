// Shared status/priority color+label maps for Project Gantt and Resource
// Planning — both render the same ActivityStatus/ProjectStatus values and
// must always agree on what each color means. Kept here (not lib/) so
// Tailwind's content glob (components/**, app/**) actually scans these
// class-name strings; lib/** is not scanned and the classes would be purged.

// Deep enough that the bars' white 10px labels clear 4.5:1, and On Hold
// moved off orange so it no longer reads as In Progress. Colour is never
// the only signal: each bar also carries a STATUS_GLYPH (gantt-chart.tsx).
export const STATUS_BAR: Record<string, string> = {
  PLANNING: "bg-blue-700",
  TODO: "bg-slate-600",
  IN_PROGRESS: "bg-amber-700",
  ON_HOLD: "bg-violet-700",
  BLOCKED: "bg-red-700",
  COMPLETED: "bg-emerald-700",
  CANCELLED: "bg-gray-500",
};

export const STATUS_LABEL: Record<string, string> = {
  PLANNING: "Planning",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export const PRIORITY_CLS: Record<string, string> = {
  LOW: "bg-green-50 text-green-700 border border-green-200",
  MEDIUM: "bg-yellow-50 text-yellow-700 border border-yellow-200",
  HIGH: "bg-orange-50 text-orange-700 border border-orange-200",
  URGENT: "bg-red-50 text-red-700 border border-red-200",
};

/** ActivityStatus keys only (excludes PLANNING, which is Project-only) — for views that never show project-level rows, e.g. Resource Planning. */
export const ACTIVITY_STATUS_KEYS = ["TODO", "IN_PROGRESS", "ON_HOLD", "BLOCKED", "COMPLETED", "CANCELLED"];
