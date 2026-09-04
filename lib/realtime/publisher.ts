import { ticketEventBus } from "./event-bus";
import type { TicketEventType, TicketRealtimeEvent } from "./types";
import { publishTicketListInvalidation } from "./ticket-list-invalidation";

/**
 * Every existing caller of this function (cancel, PATCH's status/priority/
 * assignee branches, /assign, /reply, /status) already represents a
 * successful ticket mutation that could plausibly move a ticket into or out
 * of some list's scope (status changes affect status-filtered/closed lists,
 * assignee changes affect "Assigned to Me", etc.) — so this is also the
 * single, generic "tickets changed" list-invalidation trigger for ALL of
 * them, piggybacked here rather than re-added at each of those 7 call
 * sites. This deliberately does NOT try to reason per-event-type about
 * which specific lists are affected (see the migration-safety principle:
 * "a generic invalidation followed by canonical re-fetch is acceptable and
 * preferable if simpler/safer") — every subscriber just re-runs its own
 * already-authorized query.
 */
export function publishTicketEvent(
  type: TicketEventType,
  ticketId: string,
  actorId: string,
  payload: unknown
): void {
  const event: TicketRealtimeEvent = {
    type,
    ticketId,
    payload,
    createdAt: new Date().toISOString(),
    actorId,
  };
  ticketEventBus.publish(event);
  publishTicketListInvalidation();
}
