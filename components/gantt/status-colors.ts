// Shared status/priority color+label maps for Project Gantt and Resource
// Planning — both render the same ActivityStatus/ProjectStatus values and
// must always agree on what each color means. Kept here (not lib/) so
// Tailwind's content glob (components/**, app/**) actually scans these
// class-name strings; lib/** is not scanned and the classes would be purged.

export const STATUS_BAR: Record<string, string> = {
  PLANNING: "bg-blue-500",
  TODO: "bg-slate-400",
  IN_PROGRESS: "bg-amber-500",
  ON_HOLD: "bg-orange-400",
  BLOCKED: "bg-red-500",
  COMPLETED: "bg-emerald-500",
  CANCELLED: "bg-gray-300",
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
