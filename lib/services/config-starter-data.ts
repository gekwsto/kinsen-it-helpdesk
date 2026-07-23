import type { ActivityStatus, Prisma, PrismaClient } from "@prisma/client";
import { DEFAULT_STATUS_PROGRESS } from "@/lib/activities/activity-progress";

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

export async function ensurePriorityForDepartment(
  db: Db,
  departmentId: string,
  data: { name: string; level: number; color: string }
) {
  const existing = await db.ticketPriority.findFirst({ where: { departmentId, name: data.name } });
  if (existing) return existing;
  return db.ticketPriority.create({ data: { ...data, departmentId } });
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
 * Ensures all 6 ActivityStatus rows exist for a department (idempotent,
 * never overwrites an admin's already-edited percentage) — the per-department
 * status->progress% mapping used by lib/activities/activity-progress.ts.
 */
export async function ensureActivityProgressConfigForDepartment(db: Db, departmentId: string) {
  for (const status of Object.keys(DEFAULT_STATUS_PROGRESS) as ActivityStatus[]) {
    const existing = await db.activityProgressConfig.findUnique({
      where: { departmentId_status: { departmentId, status } },
    });
    if (!existing) {
      await db.activityProgressConfig.create({
        data: { departmentId, status, progressPercent: DEFAULT_STATUS_PROGRESS[status] },
      });
    }
  }
}
