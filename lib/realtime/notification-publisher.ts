import { notificationEventBus } from "./notification-event-bus";
import type { NotificationEventPayload, NotificationRealtimeEvent } from "./notification-types";

/**
 * Centralized publish point — called exactly once, right after a
 * Notification row is successfully committed (see
 * lib/ticket-notification-service.ts's deliverRequesterPush), never
 * scattered across individual ticket routes. Synchronous and
 * exception-safe (the bus itself never throws — see
 * NotificationEventBus.publish) so a realtime failure can never surface as
 * a failure of the business operation that triggered it.
 */
export function publishNotificationCreated(
  userId: string,
  payload: NotificationEventPayload
): void {
  const event: NotificationRealtimeEvent = {
    type: "NOTIFICATION_CREATED",
    userId,
    payload,
    createdAt: new Date().toISOString(),
  };
  notificationEventBus.publish(event);
}
