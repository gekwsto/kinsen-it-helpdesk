import { prisma } from "@/lib/prisma";

/**
 * Cross-process "activity lists may need refreshing" signal — same
 * PostgreSQL LISTEN/NOTIFY architecture as
 * lib/realtime/project-list-invalidation.ts and
 * lib/realtime/ticket-list-invalidation.ts (see the latter's doc comment
 * for the full rationale: why LISTEN/NOTIFY rather than the in-process-only
 * event buses, why the payload is deliberately empty of any Activity data).
 * A DISTINCT channel from both tickets' and projects' — an Activity change
 * has no reason to wake up every open Ticket or Project list, and vice
 * versa — but the same proven mechanism, mirrored rather than shared so
 * this addition can never regress either already-working realtime path.
 */
export const ACTIVITY_LIST_CHANGED_CHANNEL = "kinsen_activity_list_changed";

function buildInvalidationPayload(): string {
  return JSON.stringify({ at: Date.now() });
}

/**
 * Fire-and-forget, non-transactional publish. Called ONLY after an Activity
 * mutation that affects a visible Activity-list column, filter option, or
 * list membership has actually committed (see app/api/activities/route.ts
 * and app/api/activities/[id]/route.ts) — never before, and never for
 * fields the Activity List/Grid views don't render or filter on (e.g.
 * description, isMilestone, subDepartmentId, businessUnitId). Never throws
 * into the caller and never blocks the response.
 */
export function publishActivityListInvalidation(): void {
  prisma
    .$executeRaw`SELECT pg_notify(${ACTIVITY_LIST_CHANGED_CHANNEL}, ${buildInvalidationPayload()})`
    .catch((err) => {
      console.error("[activity-list-invalidation] publish failed (non-fatal):", err);
    });
}
