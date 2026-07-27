import { prisma } from "@/lib/prisma";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ConfigHealthIssue {
  type:
    | "activity_progress_missing"
    | "activity_progress_disabled_while_used"
    | "activity_progress_duplicate"
    | "activity_progress_invalid_percent"
    | "activity_progress_sort_order_not_deterministic"
    | "sla_missing"
    | "sla_duplicate"
    | "sla_invalid_hours";
  detail: string;
}

export interface DepartmentConfigHealth {
  departmentId: string;
  healthy: boolean;
  issues: ConfigHealthIssue[];
}

/**
 * Central configuration-completeness check for one department — the single
 * place that answers "is this department's Activity Progress / SLA
 * configuration actually complete and internally consistent," never
 * re-derived ad hoc elsewhere. Read-only: never creates or repairs rows
 * itself (that would be a config row silently manufactured inside a read
 * path, which lib/activities/activity-progress.ts and
 * lib/services/sla-policy.ts's no-fallback policy explicitly forbids) — it
 * only reports what it finds so a human or the ensure*ForDepartment
 * functions (lib/services/config-starter-data.ts) can fix it deliberately.
 *
 * Checks:
 *  - Every ActivityStatus actually used by an existing activity in this
 *    department has exactly one ActivityProgressConfig row, and that row
 *    is enabled (a used-but-disabled row is exactly the state the
 *    usage-analysis guard in /api/admin/activity-progress is supposed to
 *    make unreachable through normal admin action — this check is what
 *    proves that guarantee held).
 *  - No duplicate ActivityProgressConfig rows per status (defensively —
 *    the DB's own @@unique([departmentId, status]) should make this
 *    impossible, but this check would catch it if it ever weren't).
 *  - Every ActivityProgressConfig row's percentage is a valid 0-100 integer.
 *  - ActivityProgressConfig sortOrder values are unique within the
 *    department (deterministic display/reorder order).
 *  - Every ACTIVE TicketPriority (SLA level) in this department has
 *    exactly one SlaPolicy row with valid (positive integer) hours.
 */
export async function checkDepartmentConfigHealth(db: Db, departmentId: string): Promise<DepartmentConfigHealth> {
  const issues: ConfigHealthIssue[] = [];

  const [usedStatuses, progressRows, priorities] = await Promise.all([
    db.projectActivity.groupBy({ by: ["status"], where: { departmentId }, _count: { _all: true } }),
    db.activityProgressConfig.findMany({ where: { departmentId } }),
    db.ticketPriority.findMany({ where: { departmentId, isActive: true }, include: { slaPolicy: true } }),
  ]);

  const progressByStatus = new Map<string, typeof progressRows>();
  for (const row of progressRows) {
    progressByStatus.set(row.status, [...(progressByStatus.get(row.status) ?? []), row]);
  }

  for (const { status } of usedStatuses) {
    const matches = progressByStatus.get(status) ?? [];
    if (matches.length === 0) {
      issues.push({ type: "activity_progress_missing", detail: `Status ${status} is used by at least one activity but has no ActivityProgressConfig row.` });
    } else if (matches.length > 1) {
      issues.push({ type: "activity_progress_duplicate", detail: `Status ${status} has ${matches.length} ActivityProgressConfig rows (expected exactly 1).` });
    } else if (!matches[0].isEnabled) {
      issues.push({ type: "activity_progress_disabled_while_used", detail: `Status ${status} is used by at least one activity but its ActivityProgressConfig row is disabled.` });
    }
  }

  for (const row of progressRows) {
    if (!Number.isInteger(row.progressPercent) || row.progressPercent < 0 || row.progressPercent > 100) {
      issues.push({ type: "activity_progress_invalid_percent", detail: `Status ${row.status} has an out-of-range progressPercent (${row.progressPercent}).` });
    }
  }

  const sortOrders = progressRows.map((r) => r.sortOrder);
  if (new Set(sortOrders).size !== sortOrders.length) {
    issues.push({ type: "activity_progress_sort_order_not_deterministic", detail: "Two or more ActivityProgressConfig rows share the same sortOrder — display/reorder order is not deterministic." });
  }

  for (const p of priorities) {
    if (!p.slaPolicy) {
      issues.push({ type: "sla_missing", detail: `Active priority "${p.name}" (${p.id}) has no SlaPolicy row.` });
    } else if (
      !Number.isInteger(p.slaPolicy.firstResponseHours) || p.slaPolicy.firstResponseHours < 1 ||
      !Number.isInteger(p.slaPolicy.resolutionHours) || p.slaPolicy.resolutionHours < 1
    ) {
      issues.push({ type: "sla_invalid_hours", detail: `Active priority "${p.name}" (${p.id}) has invalid SLA hours (firstResponseHours=${p.slaPolicy.firstResponseHours}, resolutionHours=${p.slaPolicy.resolutionHours}).` });
    }
  }

  return { departmentId, healthy: issues.length === 0, issues };
}

/** Runs the check and logs every issue loudly (never silently) — the standard call site for "after a mutation/creation/backfill, verify nothing was left inconsistent." Returns the same result so callers (e.g. tests) can assert on it directly instead of scraping console output. */
export async function logDepartmentConfigHealth(db: Db, departmentId: string, context: string): Promise<DepartmentConfigHealth> {
  const result = await checkDepartmentConfigHealth(db, departmentId);
  if (!result.healthy) {
    console.error(`[config-health] departmentId=${departmentId} (${context}): ${result.issues.length} issue(s) found:`);
    for (const issue of result.issues) console.error(`  - [${issue.type}] ${issue.detail}`);
  }
  return result;
}

/** Convenience for checking every department at once (seed/backfill verification). */
export async function checkAllDepartmentsConfigHealth(db: Db, context: string): Promise<DepartmentConfigHealth[]> {
  const departments = await db.department.findMany({ select: { id: true } });
  const results: DepartmentConfigHealth[] = [];
  for (const d of departments) {
    results.push(await logDepartmentConfigHealth(db, d.id, context));
  }
  return results;
}
