import { prisma } from "@/lib/prisma";

/**
 * There is NO numeric fallback for a missing SlaPolicy row — 8h/48h was a
 * ONE-TIME starter value applied only at row-creation time
 * (STARTER_SLA_HOURS in lib/services/config-starter-data.ts, via
 * ensureSlaPolicyForPriority — called from ensurePriorityForDepartment and
 * POST /api/admin/priorities, so every priority normally gets a real row
 * the moment it's created). Once a priority exists, its SlaPolicy row (or
 * lack of one) is the sole source of truth — a gap is a configuration
 * error, never silently treated as "8h/48h business hours." Every consumer
 * gets an `SlaResolution` discriminated union (`ok: false` on a gap) and
 * MUST render/handle that as an explicit "SLA not configured" state, never
 * substitute a number.
 *
 * SLA "levels" are TicketPriority itself (already department-scoped: name,
 * level/order, isActive) — SlaPolicy is 1:1 with a priority and carries
 * only the hours. There is deliberately no separate "SlaLevel" entity: the
 * existing, already-department-scoped TicketPriority model is the level
 * identity, reused rather than duplicated.
 */
const reportedGaps = new Set<string>();
function reportConfigGap(priorityId: string) {
  if (reportedGaps.has(priorityId)) return;
  reportedGaps.add(priorityId);
  console.error(
    `[sla-policy] configuration gap: no SlaPolicy row for priorityId=${priorityId}. ` +
    `No numeric value is substituted — this priority has "SLA not configured" until a real policy row exists. ` +
    `This should not occur after the full backfill migration; verify this priority was created via ensurePriorityForDepartment or POST /api/admin/priorities.`
  );
}

export interface SlaHours {
  firstResponseHours: number;
  resolutionHours: number;
}

export type SlaResolution = { ok: true; hours: SlaHours } | { ok: false; priorityId: string };

/** Bulk loader — one query for N priorities, never N+1 per row. Does not pre-fill missing entries — an absent row is a real signal, resolved by resolveSlaHours below. */
export async function getSlaPoliciesForPriorities(priorityIds: string[]): Promise<Record<string, SlaHours>> {
  const uniqueIds = Array.from(new Set(priorityIds));
  const rows = uniqueIds.length > 0
    ? await prisma.slaPolicy.findMany({ where: { priorityId: { in: uniqueIds } } })
    : [];
  const result: Record<string, SlaHours> = {};
  for (const row of rows) result[row.priorityId] = { firstResponseHours: row.firstResponseHours, resolutionHours: row.resolutionHours };
  return result;
}

/** Never fabricates hours on a gap — `ok: false` MUST be rendered as "SLA not configured" by the caller. */
export function resolveSlaHours(configMap: Record<string, SlaHours>, priorityId: string): SlaResolution {
  const row = configMap[priorityId];
  if (!row) {
    reportConfigGap(priorityId);
    return { ok: false, priorityId };
  }
  return { ok: true, hours: row };
}

/** For call sites that already `include: { slaPolicy: true }` on a TicketPriority query (the admin SLA pages) — same gap-logging, no-fallback behavior as the other resolvers, just fed the already-joined relation instead of a separate lookup. The single central resolution logic every SLA display (workspace SLA page, per-department SLA page, the API route) shares, never re-implemented locally as a bare `?? 8`. */
export function resolveSlaHoursFromRelation(slaPolicy: SlaHours | null, priorityId: string): SlaResolution {
  if (!slaPolicy) {
    reportConfigGap(priorityId);
    return { ok: false, priorityId };
  }
  return { ok: true, hours: slaPolicy };
}

/** Single-priority convenience wrapper. */
export async function getSlaHoursForPriority(priorityId: string): Promise<SlaResolution> {
  const row = await prisma.slaPolicy.findUnique({ where: { priorityId } });
  if (!row) {
    reportConfigGap(priorityId);
    return { ok: false, priorityId };
  }
  return { ok: true, hours: { firstResponseHours: row.firstResponseHours, resolutionHours: row.resolutionHours } };
}

/** Test-only: clears the gap-log dedupe set. Never called from application code. */
export function __resetReportedGapsForTests(): void {
  reportedGaps.clear();
}
