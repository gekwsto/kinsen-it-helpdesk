import { Client } from "pg";
import { TICKET_LIST_CHANGED_CHANNEL } from "./ticket-list-invalidation";

type Listener = () => void;

const RECONNECT_DELAY_MS = 5_000;
// In-process coalescing window: several NOTIFYs arriving in a tight burst
// (e.g. a bulk import, or a handful of near-simultaneous status changes)
// collapse into ONE local dispatch — every connected SSE stream then
// forwards exactly one "TICKETS_CHANGED" message per window, not one per
// underlying DB event. Combined with the client-side debounce in
// hooks/use-ticket-list-realtime.ts, this is what keeps a burst of ticket
// mutations from turning into a query storm of repeated page refreshes.
const DISPATCH_COALESCE_MS = 250;

/**
 * Process-local fan-out for the cross-process ticket-list-changed signal.
 * A single dedicated `pg` connection per Node process LISTENs on
 * TICKET_LIST_CHANGED_CHANNEL (raw `pg`, NOT Prisma — Prisma's query engine
 * has no API for receiving async NOTIFY push events; a long-lived raw
 * connection is the standard, minimal way to do this). Every server
 * process — regardless of how many are running — independently receives
 * every NOTIFY via ITS OWN connection and re-dispatches to whatever local
 * subscribers (SSE routes) happen to be open in THAT process, which is what
 * makes this correct with 1 process or N without any special-casing.
 *
 * Lazily connects on the first subscriber (never opens a DB connection just
 * because the module was imported/built) and reconnects with a fixed delay
 * on any connection error — this is a genuinely new failure mode (unlike
 * the in-memory event buses, this can lose its DB connection), so it must
 * never crash the process and must recover on its own.
 */
class TicketListChangeHub {
  private readonly listeners = new Set<Listener>();
  private client: Client | null = null;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensureConnected(): void {
    if (this.client || this.connecting) return;
    this.connect();
  }

  private connect(): void {
    if (!process.env.DATABASE_URL) {
      // No DB configured at all (e.g. a build step, or a misconfigured
      // environment) — fail closed/quiet rather than throwing at import
      // time; live list refresh simply won't fire, everything else in the
      // app (including the ticket lists themselves, via the normal Prisma
      // client) already depends on this same variable being set to work at
      // all, so there is nothing further to degrade here.
      return;
    }

    this.connecting = true;
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    client.on("notification", (msg) => {
      if (msg.channel === TICKET_LIST_CHANGED_CHANNEL) this.scheduleDispatch();
    });
    // A LISTEN connection that errors (dropped network, DB restart, etc.)
    // is not reusable — tear it down and reconnect from scratch rather than
    // trying to recover the same client instance.
    client.on("error", (err) => {
      console.error("[ticket-list-change-hub] connection error, will reconnect:", err.message);
      this.teardown();
      this.scheduleReconnect();
    });

    client
      .connect()
      .then(() => client.query(`LISTEN ${TICKET_LIST_CHANGED_CHANNEL}`))
      .then(() => {
        this.client = client;
        this.connecting = false;
      })
      .catch((err) => {
        console.error("[ticket-list-change-hub] failed to connect/listen, will retry:", err instanceof Error ? err.message : err);
        this.connecting = false;
        client.removeAllListeners();
        client.end().catch(() => {});
        this.scheduleReconnect();
      });
  }

  private teardown(): void {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    client.removeAllListeners();
    client.end().catch(() => {});
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Only bother reconnecting if someone is still actually subscribed —
      // no point holding a DB connection open for zero listeners.
      if (this.listeners.size > 0) this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private scheduleDispatch(): void {
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      this.listeners.forEach((fn) => {
        try {
          fn();
        } catch (err) {
          console.error("[ticket-list-change-hub] subscriber threw:", err);
        }
      });
    }, DISPATCH_COALESCE_MS);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __ticketListChangeHub: TicketListChangeHub | undefined;
}

export const ticketListChangeHub: TicketListChangeHub =
  globalThis.__ticketListChangeHub ?? (globalThis.__ticketListChangeHub = new TicketListChangeHub());
