import type { NotificationRealtimeEvent } from "./notification-types";

type EventListener = (event: NotificationRealtimeEvent) => void;

/**
 * In-process pub/sub keyed by recipient userId — same pattern as
 * lib/realtime/event-bus.ts's TicketEventBus (topic-keyed Map<key,
 * Set<listener>>, global singleton surviving Next.js hot reloads), kept as
 * a separate instance/module rather than reusing that one directly so a
 * ticketId and a userId can never collide in the same key space, and so
 * ticket realtime code stays completely untouched by this change.
 *
 * Same caveat as the ticket bus: this is single-process only. A
 * horizontally-scaled deployment (multiple Node instances) would need a
 * shared transport (Redis pub/sub, etc.) for cross-instance delivery — a
 * pre-existing characteristic of this app's realtime architecture, not
 * something introduced here (see the ticket-stream precedent this mirrors).
 */
class NotificationEventBus {
  private readonly subscribers = new Map<string, Set<EventListener>>();

  subscribe(userId: string, listener: EventListener): () => void {
    if (!this.subscribers.has(userId)) {
      this.subscribers.set(userId, new Set());
    }
    this.subscribers.get(userId)!.add(listener);

    return () => {
      const set = this.subscribers.get(userId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.subscribers.delete(userId);
      }
    };
  }

  /** Delivers only to subscribers of event.userId — never a global/"*" fan-out (unlike the ticket bus, which intentionally supports one). A private notification must never reach any other user's stream. */
  publish(event: NotificationRealtimeEvent): void {
    this.subscribers.get(event.userId)?.forEach((fn) => {
      try {
        fn(event);
      } catch {
        // A subscriber callback throwing must never break delivery to other
        // subscribers, or bubble into the caller (which just persisted a
        // Notification row and must not fail because of this).
      }
    });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __notificationEventBus: NotificationEventBus | undefined;
}

export const notificationEventBus: NotificationEventBus =
  globalThis.__notificationEventBus ??
  (globalThis.__notificationEventBus = new NotificationEventBus());
