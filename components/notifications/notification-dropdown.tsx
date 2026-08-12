"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { toast } from "sonner";
import { Bell, BellOff, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import Link from "next/link";
import { formatRelative } from "@/lib/utils";
import { useNotificationRealtime, type NotificationRealtimeEvent } from "@/hooks/use-notification-realtime";
import {
  EMPTY_NOTIFICATION_STATE,
  applyNotificationCreated,
  applyMarkRead,
  applyMarkAllRead,
  applyReconcile,
  type NotificationState,
} from "@/lib/notifications/notification-state";
import {
  isPushRuntimeConfigured,
  isPushCapableBrowser,
  shouldProceedAfterPermission,
  shouldEnableAfterSubscribeResponse,
  shouldTreatLocalSubscriptionAsEnabled,
} from "@/lib/notifications/push-client-decisions";

function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))).buffer as ArrayBuffer;
}

export function NotificationDropdown() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<NotificationState>(EMPTY_NOTIFICATION_STATE);
  const [loading, setLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  // The VAPID public key, resolved at RUNTIME from the authenticated
  // /api/notifications/push/config endpoint — never read from
  // process.env.NEXT_PUBLIC_WEB_PUSH_VAPID_PUBLIC_KEY directly. That value
  // is inlined into the client bundle at `next build` time; in this app's
  // Docker deployment the builder stage never sees the real value (.env is
  // excluded from the build context — see .dockerignore — and
  // docker-compose.yml only supplies it via env_file to the RUNTIME
  // container), so a build-time-inlined key is permanently "" in
  // production regardless of the running container's actual environment.
  // Resolving it here, from a request made after the app is already
  // running in its real runtime environment, fixes that for good.
  const publicKeyRef = useRef<string | null>(null);

  // The database is always authoritative — this fetch is used for the
  // initial load AND for reconnect reconciliation (realtime is an
  // acceleration mechanism, not the source of truth; see
  // useNotificationRealtime's onReconnect below).
  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) {
        const data = await res.json();
        setState(applyReconcile({ items: data.notifications ?? [], unreadCount: data.unreadCount ?? 0 }));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — always populated on mount (not only when the dropdown is
  // first opened), so the bell badge is correct immediately and a realtime
  // event arriving before the user ever opens the dropdown has a real base
  // list to prepend onto.
  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  // Cheap staleness guard on open — realtime keeps this live in between, so
  // this is not the primary update mechanism, just an extra reconciliation
  // point that matches the previous "refetch on open" UX.
  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  const handleRealtimeEvent = useCallback((event: NotificationRealtimeEvent) => {
    if (!event.payload) return;
    setState((prev) => applyNotificationCreated(prev, event.payload!));
  }, []);

  const handleReconnect = useCallback(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useNotificationRealtime(handleRealtimeEvent, handleReconnect);

  // Mount-time push setup: check browser capability, load the RUNTIME push
  // config (never a build-time-inlined value — see publicKeyRef's doc
  // comment above), register the service worker only when Web Push is
  // actually configured server-side, then check whether a browser
  // subscription exists AND is still known server-side (a browser-side
  // subscription can outlive its server-side row, e.g. removed after a
  // 404/410 delivery failure — only checking navigator.serviceWorker
  // locally would then wrongly report push as enabled). Deliberately never
  // calls Notification.requestPermission() here — that only ever happens
  // inside the explicit click handler below.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isPushCapableBrowser({
      hasNotification: "Notification" in window,
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: "PushManager" in window,
    })) {
      // Non-sensitive, developer-facing only — no toast, since there is
      // nothing the end user can do about browser capability.
      console.info("[push] Browser does not support the Notification/ServiceWorker/PushManager APIs — push is unavailable.");
      return;
    }

    (async () => {
      let config: { configured: boolean; publicKey: string | null };
      try {
        const res = await fetch("/api/notifications/push/config");
        if (!res.ok) {
          console.warn("[push] Failed to load runtime push configuration (non-2xx response) — push is unavailable.");
          return;
        }
        config = await res.json();
      } catch (err) {
        console.warn("[push] Failed to load runtime push configuration:", err instanceof Error ? err.message : String(err));
        return;
      }

      if (!isPushRuntimeConfigured(config)) {
        console.info("[push] Web Push is not configured on the server (missing VAPID configuration) — push is unavailable.");
        return;
      }

      publicKeyRef.current = config.publicKey;
      setPushSupported(true);

      let reg: ServiceWorkerRegistration;
      try {
        reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      } catch (err) {
        console.error("[push] Service worker registration failed:", err instanceof Error ? err.message : String(err));
        setPushSupported(false);
        return;
      }

      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setPushEnabled(false);
        return;
      }
      try {
        const res = await fetch(`/api/notifications/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`);
        const data = res.ok ? await res.json() : { subscribed: false };
        const enabled = shouldTreatLocalSubscriptionAsEnabled(data);
        if (!enabled) {
          // A real, non-sensitive mismatch: the browser has a subscription
          // the server no longer recognizes (e.g. cleaned up after a
          // 404/410 delivery failure). Never logs the endpoint itself.
          console.info("[push] Local subscription exists but is not recognized by the server — shown as disabled; click Enable to repair it.");
        }
        setPushEnabled(enabled);
      } catch (err) {
        console.warn("[push] Failed to verify subscription with the server:", err instanceof Error ? err.message : String(err));
        setPushEnabled(false);
      }
    })();
  }, []);

  const togglePush = async () => {
    setPushLoading(true);
    try {
      if (pushEnabled) {
        // register() is idempotent — returns the existing registration
        // immediately if one is already active, so this is safe even
        // though enabling already registered it once.
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          await existing.unsubscribe();
          await fetch("/api/notifications/push/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          }).catch(() => {});
        }
        setPushEnabled(false);
        return;
      }

      const publicKey = publicKeyRef.current;
      if (!publicKey) {
        toast.error("Push notifications are not available right now. Please try again later.");
        return;
      }

      // requestPermission is only ever called from this explicit,
      // user-initiated click — never automatically on page load.
      const permission = await Notification.requestPermission();
      if (!shouldProceedAfterPermission(permission)) {
        if (permission === "denied") {
          toast.error("Notifications are blocked for this site. Enable them in your browser's site settings to receive push notifications.");
        }
        // "default" — the user dismissed the prompt without choosing; no toast needed.
        return;
      }

      let reg: ServiceWorkerRegistration;
      try {
        reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
      } catch (err) {
        console.error("[push] Service worker registration failed:", err instanceof Error ? err.message : String(err));
        toast.error("Could not enable push notifications — the service worker failed to register.");
        return;
      }

      // Clear out any stale/orphaned local subscription first so a fresh
      // one is always created, rather than reusing one the server may no
      // longer know about.
      const stale = await reg.pushManager.getSubscription();
      if (stale) await stale.unsubscribe().catch(() => {});

      let sub: PushSubscription;
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      } catch (err) {
        console.error("[push] PushManager.subscribe failed:", err instanceof Error ? err.message : String(err));
        toast.error("Could not create a push subscription in this browser.");
        return;
      }

      const p256dh = sub.getKey("p256dh");
      const auth = sub.getKey("auth");
      let res: Response;
      try {
        res = await fetch("/api/notifications/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            p256dh: p256dh ? btoa(String.fromCharCode(...new Uint8Array(p256dh))) : "",
            auth: auth ? btoa(String.fromCharCode(...new Uint8Array(auth))) : "",
          }),
        });
      } catch (err) {
        console.error("[push] Failed to reach the server to register the subscription:", err instanceof Error ? err.message : String(err));
        await sub.unsubscribe().catch(() => {});
        toast.error("Could not register push notifications with the server. Please try again.");
        setPushEnabled(false);
        return;
      }

      // Never trust the subscribe attempt as successful without checking
      // the response — a non-2xx here previously still flipped the UI to
      // "enabled", showing push as on even though the server never stored
      // it (so no push would ever actually arrive).
      if (!shouldEnableAfterSubscribeResponse(res)) {
        console.error("[push] Server rejected the push subscription", { status: res.status });
        await sub.unsubscribe().catch(() => {});
        toast.error("Could not register push notifications with the server. Please try again.");
        setPushEnabled(false);
        return;
      }

      setPushEnabled(true);
    } finally {
      setPushLoading(false);
    }
  };

  const markRead = async (n: { id: string; isRead: boolean }) => {
    if (n.isRead) return;
    setState((prev) => applyMarkRead(prev, n.id));
    await fetch(`/api/notifications/${n.id}/read`, { method: "PATCH" });
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      setState((prev) => applyMarkAllRead(prev));
      await fetch("/api/notifications/mark-all-read", { method: "POST" });
    } finally {
      setMarkingAll(false);
    }
  };

  const { items, unreadCount } = state;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center leading-none">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80 p-0" sideOffset={8}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount > 0 && (
              <span className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-medium leading-none">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {pushSupported && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={togglePush}
                disabled={pushLoading}
                title={pushEnabled ? "Disable push notifications" : "Enable push notifications"}
              >
                {pushLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : pushEnabled ? (
                  <Bell className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <BellOff className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </Button>
            )}
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={markAllRead}
                disabled={markingAll}
              >
                {markingAll ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                All read
              </Button>
            )}
          </div>
        </div>

        {/* List */}
        <div className="max-h-[360px] overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No notifications yet
            </p>
          ) : (
            items.map((n) => {
              const row = (
                <div
                  className={`flex items-start gap-3 px-4 py-3 border-b last:border-0 hover:bg-muted/50 cursor-pointer transition-colors ${
                    !n.isRead ? "bg-blue-50/60" : ""
                  }`}
                  onClick={() => markRead(n)}
                >
                  <span
                    className={`mt-1.5 h-2 w-2 rounded-full flex-shrink-0 ${
                      n.isRead ? "opacity-0" : "bg-blue-500"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-tight">{n.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {formatRelative(new Date(n.createdAt))}
                    </p>
                  </div>
                </div>
              );

              return n.link ? (
                <Link
                  key={n.id}
                  href={n.link}
                  onClick={() => {
                    markRead(n);
                    setOpen(false);
                  }}
                >
                  {row}
                </Link>
              ) : (
                <div key={n.id}>{row}</div>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
