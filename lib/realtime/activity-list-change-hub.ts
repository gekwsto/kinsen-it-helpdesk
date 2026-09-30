import { Client } from "pg";
import { ACTIVITY_LIST_CHANGED_CHANNEL } from "./activity-list-invalidation";

type Listener = () => void;

const RECONNECT_DELAY_MS = 5_000;
// Same in-process coalescing rationale as project-list-change-hub.ts/ticket-list-change-hub.ts.
const DISPATCH_COALESCE_MS = 250;

/**
 * Process-local fan-out for the cross-process activity-list-changed signal —
 * identical shape to lib/realtime/project-list-change-hub.ts (see that
 * file's doc comment for the full design rationale), mirrored rather than
 * generalized into a shared multi-channel hub so this addition can never
 * regress the already-working project/ticket realtime paths. A separate
 * lazy connection, opened only once an Activities list page actually
 * subscribes.
 */
class ActivityListChangeHub {
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
      return;
    }

    this.connecting = true;
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    client.on("notification", (msg) => {
      if (msg.channel === ACTIVITY_LIST_CHANGED_CHANNEL) this.scheduleDispatch();
    });
    client.on("error", (err) => {
      console.error("[activity-list-change-hub] connection error, will reconnect:", err.message);
      this.teardown();
      this.scheduleReconnect();
    });

    client
      .connect()
      .then(() => client.query(`LISTEN ${ACTIVITY_LIST_CHANGED_CHANNEL}`))
      .then(() => {
        this.client = client;
        this.connecting = false;
      })
      .catch((err) => {
        console.error("[activity-list-change-hub] failed to connect/listen, will retry:", err instanceof Error ? err.message : err);
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
          console.error("[activity-list-change-hub] subscriber threw:", err);
        }
      });
    }, DISPATCH_COALESCE_MS);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __activityListChangeHub: ActivityListChangeHub | undefined;
}

export const activityListChangeHub: ActivityListChangeHub =
  globalThis.__activityListChangeHub ?? (globalThis.__activityListChangeHub = new ActivityListChangeHub());
