/**
 * Realtime event shape for the in-app notification bell — a sibling to
 * lib/realtime/types.ts's TicketRealtimeEvent, deliberately NOT merged into
 * it: tickets are keyed by ticketId (any number of viewers), notifications
 * are keyed by the single recipient's userId (private, single-owner topic).
 * Keeping separate types/bus/publisher avoids ever mixing a ticketId and a
 * userId in the same subscription key space.
 */

export const NotificationEventTypes = {
  NOTIFICATION_CREATED: "NOTIFICATION_CREATED",
  CONNECTED: "CONNECTED",
} as const;

export type NotificationEventType =
  (typeof NotificationEventTypes)[keyof typeof NotificationEventTypes];

/** The only fields the UI needs — never the full Notification row indiscriminately, and never any ticket/user data the recipient shouldn't see. */
export interface NotificationEventPayload {
  id: string;
  title: string;
  body: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface NotificationRealtimeEvent {
  type: NotificationEventType;
  /** The recipient's userId — used server-side only, to pick the pub/sub topic. Never broadcast to any other user's stream. */
  userId: string;
  payload: NotificationEventPayload | null;
  createdAt: string;
}
