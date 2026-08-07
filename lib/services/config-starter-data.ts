import type { ActivityStatus, ProjectStatus, ActivityPriority, Prisma, PrismaClient } from "@prisma/client";
import { ProjectStatus as ProjectStatusEnum, ActivityStatus as ActivityStatusEnum, ActivityPriority as ActivityPriorityEnum } from "@prisma/client";

/**
 * Static starter values for a brand-new department's own Categories/
 * Priorities/Statuses. Used by prisma/seed.ts (applied to every department
 * on a fresh install) and by scripts/retire-global-config.ts only as a
 * fallback shape reference — that script actually copies IT's live,
 * possibly-since-edited rows rather than these static values, since "current
 * IT set" (not "original seed defaults") is what should be copied to the
 * other departments during the one-time migration.
 */
export const STARTER_CATEGORIES = [
  { name: "Hardware", description: "Physical device issues", color: "#6366f1" },
  { name: "Software", description: "Application or OS issues", color: "#8b5cf6" },
  { name: "Network", description: "Connectivity and network issues", color: "#06b6d4" },
  { name: "Access & Permissions", description: "Login, permissions, account issues", color: "#14b8a6" },
  { name: "Email", description: "Email client and server issues", color: "#f59e0b" },
  { name: "Printing", description: "Printer and printing issues", color: "#f97316" },
  { name: "Security", description: "Security incidents and concerns", color: "#ef4444" },
  { name: "General IT", description: "General IT support requests", color: "#6b7280" },
];

export const STARTER_PRIORITIES = [
  { name: "High", level: 3, color: "#f97316" },
  { name: "Medium", level: 2, color: "#f59e0b" },
  { name: "Low", level: 1, color: "#22c55e" },
];

export const STARTER_STATUSES = [
  { name: "Open", color: "#3b82f6", isDefault: true, isClosed: false, order: 1 },
  { name: "In Progress", color: "#f59e0b", isDefault: false, isClosed: false, order: 2 },
  { name: "Pending User", color: "#8b5cf6", isDefault: false, isClosed: false, order: 3 },
  { name: "Resolved", color: "#10b981", isDefault: false, isClosed: false, order: 4 },
  { name: "Closed", color: "#6b7280", isDefault: false, isClosed: true, order: 5 },
  { name: "Cancelled", color: "#ef4444", isDefault: false, isClosed: true, order: 6 },
];

type Db = PrismaClient | Prisma.TransactionClient;

/** Find-then-create-if-missing by the real (departmentId, name) natural key — never upsert-by-id (see prisma/seed.ts's header comment on why: it silently duplicates on an already-seeded DB). */
export async function ensureCategoryForDepartment(
  db: Db,
  departmentId: string,
  data: { name: string; description?: string | null; color: string }
) {
  const existing = await db.ticketCategory.findFirst({ where: { departmentId, name: data.name } });
  if (existing) return existing;
  return db.ticketCategory.create({ data: { ...data, departmentId } });
}

/**
 * ONE-TIME starter SLA hours for a priority's SlaPolicy row — consulted
 * ONLY by ensureSlaPolicyForPriority below, never by the runtime resolver
 * (lib/services/sla-policy.ts), which only ever reads the real row and
 * treats a missing one as a logged configuration gap.
 */
export const STARTER_SLA_HOURS = { firstResponseHours: 8, resolutionHours: 48 };

/** Ensures a priority has an SlaPolicy row (idempotent, never overwrites an admin's already-edited hours) — called from ensurePriorityForDepartment below and from POST /api/admin/priorities, so every priority (seeded or admin-created) always has real SLA hours to read, never a gap in normal operation. */
export async function ensureSlaPolicyForPriority(db: Db, priorityId: string) {
  const existing = await db.slaPolicy.findUnique({ where: { priorityId } });
  if (existing) return existing;
  return db.slaPolicy.create({ data: { priorityId, ...STARTER_SLA_HOURS } });
}

export async function ensurePriorityForDepartment(
  db: Db,
  departmentId: string,
  data: { name: string; level: number; color: string }
) {
  const existing = await db.ticketPriority.findFirst({ where: { departmentId, name: data.name } });
  const priority = existing ?? (await db.ticketPriority.create({ data: { ...data, departmentId } }));
  // Every priority — freshly created here or already existing from a prior
  // run — always gets its SLA policy ensured too, so seed.ts's own starter
  // loop and any other ensurePriorityForDepartment caller can never leave
  // a priority without real SLA hours to read.
  await ensureSlaPolicyForPriority(db, priority.id);
  return priority;
}

/** Loops STARTER_PRIORITIES for a single department — used by createDepartment() so a brand-new department gets the same starter priority set (and, via ensurePriorityForDepartment, starter SLA hours) seed.ts already gives the bootstrap departments. */
export async function ensureStarterPrioritiesForDepartment(db: Db, departmentId: string) {
  for (const priority of STARTER_PRIORITIES) {
    await ensurePriorityForDepartment(db, departmentId, priority);
  }
}

/**
 * Loops STARTER_STATUSES for a single department — the TicketStatus
 * counterpart of ensureStarterPrioritiesForDepartment above. Every caller
 * that needed a working TicketStatus for a freshly-created department
 * (seed.ts, several test-*.ts scripts) previously had to call
 * ensureStatusForDepartment for each starter status itself, one at a time,
 * because createDepartment() never did this despite its own header comment
 * promising a complete starter set — a real gap (Open/Closed/etc. never
 * existed for any department created purely through createDepartment(),
 * including every admin-created department and, since Microsoft Directory
 * Sync started calling createDepartment() too, every Microsoft-sourced
 * department) that left those departments unable to have a ticket created
 * for them at all (no default TicketStatus to assign). Fixed once here, at
 * the shared root, rather than in any one caller.
 */
export async function ensureStarterStatusesForDepartment(db: Db, departmentId: string) {
  for (const status of STARTER_STATUSES) {
    await ensureStatusForDepartment(db, departmentId, status);
  }
}

export async function ensureStatusForDepartment(
  db: Db,
  departmentId: string,
  data: { name: string; color: string; isDefault?: boolean; isClosed?: boolean; order: number }
) {
  const existing = await db.ticketStatus.findFirst({ where: { departmentId, name: data.name } });
  if (existing) return existing;
  return db.ticketStatus.create({ data: { ...data, departmentId } });
}

/**
 * ONE-TIME starter percentages + display order for a brand-new department's
 * ActivityProgressConfig rows — consulted ONLY by ensureActivityProgressConfigForDepartment
 * below, never by the runtime resolver (lib/activities/activity-progress.ts),
 * which only ever reads real rows and treats a missing/disabled one as a
 * logged configuration gap with a fixed fail-safe — never a "the status
 * name looks X% done" guess.
 */
export const STARTER_ACTIVITY_PROGRESS: Record<ActivityStatus, { progressPercent: number; sortOrder: number }> = {
  TODO: { progressPercent: 0, sortOrder: 0 },
  IN_PROGRESS: { progressPercent: 50, sortOrder: 1 },
  ON_HOLD: { progressPercent: 50, sortOrder: 2 },
  BLOCKED: { progressPercent: 50, sortOrder: 3 },
  COMPLETED: { progressPercent: 100, sortOrder: 4 },
  CANCELLED: { progressPercent: 0, sortOrder: 5 },
};

/**
 * Ensures all 6 ActivityStatus rows exist for a department (idempotent,
 * never overwrites an admin's already-edited percentage/isEnabled/sortOrder)
 * — the per-department status->progress% mapping used by
 * lib/activities/activity-progress.ts. A department can later disable or
 * delete individual rows via /admin/activity-progress (full CRUD) — this
 * function only ever fills in what's genuinely missing.
 */
export async function ensureActivityProgressConfigForDepartment(db: Db, departmentId: string) {
  for (const status of Object.values(ActivityStatusEnum)) {
    const existing = await db.activityProgressConfig.findUnique({
      where: { departmentId_status: { departmentId, status } },
    });
    if (!existing) {
      const starter = STARTER_ACTIVITY_PROGRESS[status];
      await db.activityProgressConfig.create({
        data: { departmentId, status, progressPercent: starter.progressPercent, sortOrder: starter.sortOrder, isEnabled: true },
      });
    }
  }
}

/**
 * ONE-TIME starter values for a brand-new department's ProjectStatusConfig/
 * ActivityStatusConfig/ActivityPriorityConfig rows — consulted ONLY by the
 * ensure*ForDepartment functions directly below (called from
 * createDepartment() and prisma/seed.ts), never by the runtime resolvers
 * (lib/status-terminal.ts, lib/priority-config.ts). Those resolvers only
 * ever read real rows and treat a missing one as a logged configuration
 * gap with a fixed fail-safe value — never a "the status name looks
 * terminal" guess. This is the one explicit, admin-overridable place a
 * status/priority's initial meaning is asserted from its name at all.
 */
export const STARTER_PROJECT_TERMINAL: Record<ProjectStatus, boolean> = {
  PLANNING: false,
  IN_PROGRESS: false,
  ON_HOLD: false,
  COMPLETED: true,
  CANCELLED: true,
};

export const STARTER_ACTIVITY_TERMINAL: Record<ActivityStatus, boolean> = {
  TODO: false,
  IN_PROGRESS: false,
  ON_HOLD: false,
  BLOCKED: false,
  COMPLETED: true,
  CANCELLED: true,
};

/** Ascending = most urgent first (0 is highest urgency) — the starter order only; lib/priority-config.ts reads the actual per-department sortOrder column afterwards. */
export const STARTER_ACTIVITY_PRIORITY_ORDER: Record<ActivityPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

/** Ensures all 5 ProjectStatus rows exist for a department (idempotent, never overwrites an admin's already-edited isTerminal value) — read by lib/status-terminal.ts's resolveProjectTerminal. */
export async function ensureProjectStatusConfigForDepartment(db: Db, departmentId: string) {
  for (const status of Object.values(ProjectStatusEnum)) {
    const existing = await db.projectStatusConfig.findUnique({ where: { departmentId_status: { departmentId, status } } });
    if (!existing) {
      await db.projectStatusConfig.create({ data: { departmentId, status, isTerminal: STARTER_PROJECT_TERMINAL[status] } });
    }
  }
}

/**
 * ONE-TIME starter display metadata (label/color/sortOrder) for a
 * brand-new department's ActivityStatusConfig rows — consulted ONLY by
 * ensureActivityStatusConfigForDepartment below, never by the runtime
 * resolver (lib/services/activity-status-config.ts), which only ever reads
 * real rows and treats a missing one as a logged configuration gap with a
 * fixed fail-safe (the raw enum key itself) — never a per-department guess.
 * Matches the previous single app-wide hardcoded values
 * (components/gantt/status-colors.ts's STATUS_LABEL/STATUS_BAR) so nothing
 * visually changes for an existing department until an admin edits it.
 */
export const STARTER_ACTIVITY_STATUS_DISPLAY: Record<ActivityStatus, { label: string; color: string; sortOrder: number }> = {
  TODO: { label: "To Do", color: "#94a3b8", sortOrder: 0 },
  IN_PROGRESS: { label: "In Progress", color: "#f59e0b", sortOrder: 1 },
  ON_HOLD: { label: "On Hold", color: "#fb923c", sortOrder: 2 },
  BLOCKED: { label: "Blocked", color: "#ef4444", sortOrder: 3 },
  COMPLETED: { label: "Completed", color: "#10b981", sortOrder: 4 },
  CANCELLED: { label: "Cancelled", color: "#d1d5db", sortOrder: 5 },
};

/** Ensures all 6 ActivityStatus rows exist for a department (idempotent, never overwrites an admin's already-edited label/color/sortOrder/isEnabled/isTerminal) — read by lib/status-terminal.ts's resolveActivityTerminal AND lib/services/activity-status-config.ts's display resolver (the SAME table, never a second mechanism). */
export async function ensureActivityStatusConfigForDepartment(db: Db, departmentId: string) {
  for (const status of Object.values(ActivityStatusEnum)) {
    const existing = await db.activityStatusConfig.findUnique({ where: { departmentId_status: { departmentId, status } } });
    if (!existing) {
      const display = STARTER_ACTIVITY_STATUS_DISPLAY[status];
      await db.activityStatusConfig.create({
        data: { departmentId, status, isTerminal: STARTER_ACTIVITY_TERMINAL[status], label: display.label, color: display.color, sortOrder: display.sortOrder, isEnabled: true },
      });
    }
  }
}

/** Ensures all 4 ActivityPriority rows exist for a department (idempotent, never overwrites an admin's already-edited sortOrder/isEnabled) — read by lib/priority-config.ts. */
export async function ensureActivityPriorityConfigForDepartment(db: Db, departmentId: string) {
  for (const priority of Object.values(ActivityPriorityEnum)) {
    const existing = await db.activityPriorityConfig.findUnique({ where: { departmentId_priority: { departmentId, priority } } });
    if (!existing) {
      await db.activityPriorityConfig.create({
        data: { departmentId, priority, sortOrder: STARTER_ACTIVITY_PRIORITY_ORDER[priority], isEnabled: true },
      });
    }
  }
}

/** Convenience wrapper calling all three ensure*ForDepartment functions above — used by createDepartment() and prisma/seed.ts so callers don't have to remember to invoke all three separately. */
export async function ensureStatusAndPriorityConfigForDepartment(db: Db, departmentId: string) {
  await ensureProjectStatusConfigForDepartment(db, departmentId);
  await ensureActivityStatusConfigForDepartment(db, departmentId);
  await ensureActivityPriorityConfigForDepartment(db, departmentId);
}
