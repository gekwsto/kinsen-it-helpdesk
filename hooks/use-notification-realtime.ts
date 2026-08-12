"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { NotificationRealtimeEvent } from "@/lib/realtime/notification-types";

export type { NotificationRealtimeEvent };

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Subscribes to the current user's SSE notification stream
 * (/api/notifications/stream — scoped server-side to the authenticated
 * session, never a client-supplied id). Mirrors
 * hooks/use-ticket-realtime.ts's connect/reconnect shape (3 s backoff on
 * error) with one addition: `onReconnect` fires on every connection AFTER
 * the first (native EventSource `onopen`, which fires for both the initial
 * connect and every automatic/manual reconnect) — realtime delivery is not
 * guaranteed while disconnected, so the caller uses this to refetch/
 * reconcile from the database (the authoritative source) rather than
 * trusting that no events were missed.
 */
export function useNotificationRealtime(
  onEvent: (event: NotificationRealtimeEvent) => void,
  onReconnect: () => void,
  enabled = true
) {
  const onEventRef = useRef(onEvent);
  const onReconnectRef = useRef(onReconnect);
  useIsomorphicLayoutEffect(() => {
    onEventRef.current = onEvent;
    onReconnectRef.current = onReconnect;
  });

  useEffect(() => {
    if (!enabled) return;
    if (typeof EventSource === "undefined") return;

    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;
    let hasConnectedBefore = false;

    const connect = () => {
      if (destroyed) return;
      es = new EventSource("/api/notifications/stream");

      es.onopen = () => {
        if (hasConnectedBefore) {
          onReconnectRef.current();
        }
        hasConnectedBefore = true;
      };

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as NotificationRealtimeEvent;
          if (event.type === "NOTIFICATION_CREATED") {
            onEventRef.current(event);
          }
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
  }, [enabled]);
}
