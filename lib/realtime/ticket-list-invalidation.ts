import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Cross-process "ticket lists may need refreshing" signal, backed by
 * PostgreSQL LISTEN/NOTIFY — NOT the existing in-process
 * lib/realtime/event-bus.ts (ticketEventBus) / notification-event-bus.ts,
 * which are both explicitly documented as single-process-only and would
 * silently fail to deliver across multiple Node instances/containers (a
 * real possibility for this self-hosted Docker/Vercel app). Reuses the
 * SAME PostgreSQL database this app already depends on for everything else
 * — no new external service (no Redis), and the payload is deliberately
 * TINY and non-sensitive (see below): this channel is an invalidation
 * pulse, never a data-delivery channel.
 *
 * Every subscriber (see ticket-list-change-hub.ts) reacts by re-running
 * its OWN existing, fully authorized server-side ticket query — this
 * channel is not, and must never become, an authorization boundary.
 */
export const TICKET_LIST_CHANGED_CHANNEL = "kinsen_ticket_list_changed";

/**
 * Deliberately generic and empty of any ticket-specific data — no ticket
 * id, no field values, nothing that differs between recipients. Every
 * connected browser tab gets the exact same signal regardless of what it
 * can actually see; the real authorization happens entirely in the
 * server-side query that runs when the client reacts to this by refreshing.
 */
function buildInvalidationPayload(): string {
  return JSON.stringify({ at: Date.now() });
}

/**
 * Fire-and-forget, non-transactional publish — used by the (non-transactional)
 * ticket UPDATE/assign/status/cancel/department-transfer/delete routes,
 * piggybacked once inside publishTicketEvent() (lib/realtime/publisher.ts)
 * rather than re-added at every one of those call sites individually. Never
 * throws into the caller and never blocks the response: a NOTIFY failure
 * (e.g. a transient DB hiccup) must not fail the ticket mutation that
 * already succeeded.
 */
export function publishTicketListInvalidation(): void {
  prisma
    .$executeRaw`SELECT pg_notify(${TICKET_LIST_CHANGED_CHANNEL}, ${buildInvalidationPayload()})`
    .catch((err) => {
      console.error("[ticket-list-invalidation] publish failed (non-fatal):", err);
    });
}

/**
 * Transactional variant — used inside the two canonical ticket CREATION
 * boundaries (createTicketAtomic for WEB/API, acceptPendingTicket for
 * EMAIL) via the transaction's own `tx` client. PostgreSQL defers actual
 * delivery of a NOTIFY issued inside a transaction until that transaction
 * COMMITs, and silently drops it if the transaction rolls back — so this
 * can never announce a ticket that didn't actually get created, with zero
 * extra coordination needed.
 */
export async function publishTicketListInvalidationInTransaction(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${TICKET_LIST_CHANGED_CHANNEL}, ${buildInvalidationPayload()})`;
}
