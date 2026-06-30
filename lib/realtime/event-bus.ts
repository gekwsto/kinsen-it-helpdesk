import type { TicketRealtimeEvent } from "./types";

type EventListener = (event: TicketRealtimeEvent) => void;

class TicketEventBus {
  private readonly subscribers = new Map<string, Set<EventListener>>();

  subscribe(key: string, listener: EventListener): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(listener);

    return () => {
      const set = this.subscribers.get(key);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.subscribers.delete(key);
      }
    };
  }

  publish(event: TicketRealtimeEvent): void {
    // Notify per-ticket subscribers
    this.subscribers.get(event.ticketId)?.forEach((fn) => {
      try {
        fn(event);
      } catch {}
    });
    // Notify global subscribers (key = "*")
    this.subscribers.get("*")?.forEach((fn) => {
      try {
        fn(event);
      } catch {}
    });
  }
}

// Global singleton — survives Next.js hot reloads in dev
declare global {
  // eslint-disable-next-line no-var
  var __ticketEventBus: TicketEventBus | undefined;
}

export const ticketEventBus: TicketEventBus =
  globalThis.__ticketEventBus ??
  (globalThis.__ticketEventBus = new TicketEventBus());
