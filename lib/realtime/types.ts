export const TicketEventTypes = {
  TICKET_MESSAGE_CREATED: "TICKET_MESSAGE_CREATED",
  TICKET_INTERNAL_NOTE_CREATED: "TICKET_INTERNAL_NOTE_CREATED",
  TICKET_STATUS_CHANGED: "TICKET_STATUS_CHANGED",
  TICKET_PRIORITY_CHANGED: "TICKET_PRIORITY_CHANGED",
  TICKET_CATEGORY_CHANGED: "TICKET_CATEGORY_CHANGED",
  TICKET_ASSIGNEE_CHANGED: "TICKET_ASSIGNEE_CHANGED",
  TICKET_UPDATED: "TICKET_UPDATED",
  CONNECTED: "CONNECTED",
} as const;

export type TicketEventType =
  (typeof TicketEventTypes)[keyof typeof TicketEventTypes];

export interface TicketRealtimeEvent {
  type: TicketEventType;
  ticketId: string;
  payload: unknown;
  createdAt: string;
  actorId: string;
}
