"use client";

import { useEffect, useRef } from "react";

// Client-side debounce: several TICKETS_CHANGED messages arriving close
// together (on top of the server-side coalescing in
// lib/realtime/ticket-list-change-hub.ts) collapse into a single onChange
// call — this is the actual cap on how often a consumer (router.refresh())
// can fire, since that's the operation that would otherwise cause a query
// storm against the ticket list's own server-side query.
const DEBOUNCE_MS = 500;

/**
 * Subscribes to the generic ticket-list-changed SSE stream
 * (app/api/tickets/stream/route.ts) and calls onChange (debounced) for
 * every TICKETS_CHANGED message. Carries no ticket data — onChange's only
 * job is to trigger a re-fetch of the caller's own already-authorized data
 * (see components/tickets/ticket-list-live-refresh.tsx, which calls
 * router.refresh()). Automatically reconnects on error (3s backoff) —
 * mirrors hooks/use-ticket-realtime.ts's established pattern exactly.
 */
export function useTicketListRealtime(onChange: () => void, enabled = true) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const scheduleChange = () => {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        debounceTimeout = null;
        onChangeRef.current();
      }, DEBOUNCE_MS);
    };

    const connect = () => {
      if (destroyed) return;
      es = new EventSource("/api/tickets/stream");

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event?.type === "TICKETS_CHANGED") scheduleChange();
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
      if (debounceTimeout) clearTimeout(debounceTimeout);
    };
  }, [enabled]);
}
