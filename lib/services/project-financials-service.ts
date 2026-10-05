import { Prisma } from "@prisma/client";

/**
 * The exact subset of a ProjectActivity row this calculation needs — a
 * plain shape rather than the full Prisma ProjectActivity type, so any
 * caller that already has these three columns loaded (a `findUnique`
 * include, a `findMany`, a freshly-updated row) can pass it straight
 * through without re-selecting anything.
 */
export interface ActivityFinancialInputs {
  taskTypeCost: Prisma.Decimal | null;
  expectedDays: number | null;
  actualDays: number | null;
}

export interface ProjectFinancials {
  estimatedCost: Prisma.Decimal;
  actualCost: Prisma.Decimal;
}

/**
 * THE single authoritative aggregation for a request-origin Project's
 * derived financial totals (Project.budget/estimatedCost/actualCost were
 * removed from the schema entirely — see
 * prisma/migrations/20261005090000_remove_project_budget_and_cost_columns —
 * these are now computed fresh from the Project's own Activities every time
 * they're read, never incrementally maintained with `+=`/`-=`, which would
 * be fragile around retries, duplicate requests, concurrent tabs, reopen/
 * re-complete, deleted Activities, and changed Task Types/dates).
 *
 * Activity Estimated Cost = taskTypeCost × expectedDays. Both must be
 * present (a legacy/incomplete Activity — null taskTypeId, or dates not yet
 * set — contributes exactly 0, never a fabricated value).
 *
 * Activity Actual Cost = taskTypeCost × actualDays. actualDays is null
 * except while the Activity is CURRENTLY in COMPLETED status (see
 * app/api/activities/[id]/route.ts's reopen/re-complete lifecycle: reopening
 * clears it back to null, re-completing recomputes it from the NEW
 * completedAt) — so a reopened Activity automatically contributes 0 here
 * with zero extra bookkeeping, and completing it again automatically
 * contributes its freshly-recalculated amount, never the old one alongside
 * it (this function only ever sees the Activity's CURRENT row, never a
 * history of past completions).
 *
 * Exact Decimal arithmetic throughout (Prisma.Decimal, the same type
 * taskTypeCost itself is stored/returned as) — never JS floating point. A
 * zero-day Activity contributes exactly €0 (not skipped); a null
 * taskTypeCost/expectedDays/actualDays contributes nothing (not €0 by
 * coincidence of `0 * x`, genuinely excluded).
 */
export function computeProjectFinancials(activities: ActivityFinancialInputs[]): ProjectFinancials {
  let estimatedCost = new Prisma.Decimal(0);
  let actualCost = new Prisma.Decimal(0);
  for (const activity of activities) {
    if (activity.taskTypeCost !== null && activity.expectedDays !== null) {
      estimatedCost = estimatedCost.plus(activity.taskTypeCost.times(activity.expectedDays));
    }
    if (activity.taskTypeCost !== null && activity.actualDays !== null) {
      actualCost = actualCost.plus(activity.taskTypeCost.times(activity.actualDays));
    }
  }
  return { estimatedCost, actualCost };
}

/**
 * Same derivation, for a single Activity's own Estimated/Actual Cost display
 * (Activity creation/detail/edit) — reuses computeProjectFinancials with a
 * one-element array rather than duplicating the arithmetic.
 */
export function computeActivityFinancials(activity: ActivityFinancialInputs): ProjectFinancials {
  return computeProjectFinancials([activity]);
}
