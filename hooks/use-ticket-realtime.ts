"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { TicketRealtimeEvent } from "@/lib/realtime/types";

export type { TicketRealtimeEvent };

// Re-export so consumers don't need to import from lib/realtime directly
export type { TicketEventType } from "@/lib/realtime/types";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Subscribes to the SSE stream for a ticket and calls onEvent for each event.
 * Automatically reconnects on error (3 s backoff).
 * Safe to call with enabled=false to pause the subscription.
 */
export function useTicketRealtime(
  ticketId: string,
  onEvent: (event: TicketRealtimeEvent) => void,
  enabled = true
) {
  // Keep the callback ref-stable so we don't reconnect on every render
  const onEventRef = useRef(onEvent);
  useIsomorphicLayoutEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      es = new EventSource(`/api/tickets/${ticketId}/stream`);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as TicketRealtimeEvent;
          onEventRef.current(event);
        } catch {}
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (!destroyed) {
          retryTimeout = setTimeout(connect, 3_000);
        }
      };
    };

    connect();

    return () => {
      destroyed = true;
      es?.close();
      if (retryTimeout) clearTimeout(retryTimeout);
    };
  }, [ticketId, enabled]);
}
