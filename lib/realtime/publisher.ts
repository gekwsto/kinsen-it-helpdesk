import { ticketEventBus } from "./event-bus";
import type { TicketEventType, TicketRealtimeEvent } from "./types";

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
}
