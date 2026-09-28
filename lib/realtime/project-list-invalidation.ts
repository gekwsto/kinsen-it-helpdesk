import { prisma } from "@/lib/prisma";

/**
 * Cross-process "project lists may need refreshing" signal — same
 * PostgreSQL LISTEN/NOTIFY architecture as
 * lib/realtime/ticket-list-invalidation.ts (see that file's doc comment for
 * the full rationale: why LISTEN/NOTIFY rather than the in-process-only
 * event buses, why the payload is deliberately empty of any Project data).
 * A DISTINCT channel from tickets' — a Project status change has no reason
 * to wake up every open Ticket list, and vice versa — but the same proven
 * mechanism, mirrored rather than shared so this addition can never regress
 * the already-working ticket realtime path.
 */
export const PROJECT_LIST_CHANGED_CHANNEL = "kinsen_project_list_changed";

function buildInvalidationPayload(): string {
  return JSON.stringify({ at: Date.now() });
}

/**
 * Fire-and-forget, non-transactional publish. Called ONLY after a Project
 * status change has actually committed (see PATCH /api/projects/[id]) —
 * never before, and never for other Project field edits, keeping this
 * signal precisely scoped to what actually needs a list-level refresh.
 * Never throws into the caller and never blocks the response.
 */
export function publishProjectListInvalidation(): void {
  prisma
    .$executeRaw`SELECT pg_notify(${PROJECT_LIST_CHANGED_CHANNEL}, ${buildInvalidationPayload()})`
    .catch((err) => {
      console.error("[project-list-invalidation] publish failed (non-fatal):", err);
    });
}
