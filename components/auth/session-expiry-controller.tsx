"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getSessionSyncChannel, broadcastLogout } from "@/lib/client-session-broadcast";
import { computeSessionExpiryUiState, SESSION_WARNING_BEFORE_MS } from "@/lib/session-expiry";

/**
 * Safety-net recheck interval, alongside the scheduled timeouts below and
 * the visibilitychange/focus listeners — belt-and-braces against a browser
 * throttling/coalescing a background tab's timer without firing a
 * visibilitychange/focus event first (observed engine-specific behavior,
 * not hypothetical) or a scheduled timeout otherwise not firing exactly on
 * time. Cheap (a single Date.now() comparison), so a short interval costs
 * nothing.
 */
const SAFETY_NET_INTERVAL_MS = 15_000;

/** setTimeout delays beyond ~24.8 days silently fire immediately in some engines — irrelevant at an 8h maximum, capped defensively anyway since it's free. */
const MAX_TIMEOUT_MS = 2_147_483_000;

/**
 * Central, single session-expiration controller — mounted ONCE in
 * app/(main)/layout.tsx, never per-page. Reads the AUTHORITATIVE
 * `absoluteSessionExpiresAt` the server stamped at login
 * (lib/auth.ts's jwt/session callbacks — never recomputed here, never a
 * hardcoded 8h), and is purely a CLIENT-SIDE UX layer: the actual
 * enforcement that makes an expired session unusable happens server-side
 * (lib/auth.config.ts's `authorized` callback + lib/auth.ts's jwt callback)
 * regardless of whether this component ever runs at all — this component's
 * only job is to proactively sign the user out and redirect BEFORE they'd
 * otherwise hit a 401/redirect on their next action, and to show the
 * required warning.
 */
export function SessionExpiryController() {
  const { data: session } = useSession();
  const expiresAt = session?.user?.absoluteSessionExpiresAt ?? null;

  const [showWarning, setShowWarning] = useState(false);
  const hasActedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const signOutNow = useCallback((reason: "expired" | "manual") => {
    if (hasActedRef.current) return;
    hasActedRef.current = true;
    setShowWarning(false);
    broadcastLogout(channelRef.current);
    void signOut({ callbackUrl: reason === "expired" ? "/login?message=session_expired" : "/login" });
  }, []);

  // Cross-tab sync — listens independently of whether `expiresAt` has
  // loaded yet, so a tab still fetching its own session still reacts
  // immediately to another tab's expiry or manual sign-out (including the
  // existing Topbar "Sign out" menu item, which also broadcasts on this
  // same channel).
  useEffect(() => {
    const channel = getSessionSyncChannel();
    channelRef.current = channel;
    if (!channel) return;
    const onMessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === "LOGOUT" && !hasActedRef.current) {
        hasActedRef.current = true;
        setShowWarning(false);
        void signOut({ callbackUrl: "/login" });
      }
    };
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, []);

  useEffect(() => {
    if (!expiresAt) return;
    hasActedRef.current = false;

    let scheduledTimeout: ReturnType<typeof setTimeout> | null = null;

    // Always a fresh `Date.now()` vs. the authoritative `expiresAt`, via
    // the same pure computeSessionExpiryUiState this module's tests exercise
    // directly — never trusts that a previously-scheduled timer fired
    // exactly when expected (background-tab throttling, system sleep, and
    // long setTimeout delays are all real, observed sources of drift this
    // deliberately doesn't depend on).
    function evaluate() {
      if (hasActedRef.current) return;
      const { action, remainingMs } = computeSessionExpiryUiState(expiresAt!);

      if (action === "signout") {
        signOutNow("expired");
        return;
      }

      setShowWarning(action === "warn");

      if (scheduledTimeout) clearTimeout(scheduledTimeout);
      // Re-check at whichever comes first: the warning threshold, or true
      // expiry — either way `evaluate()` just re-runs this same logic, so
      // there's no separate "warning" vs. "expiry" timer to keep in sync.
      const nextCheckInMs = action === "warn" ? remainingMs : remainingMs - SESSION_WARNING_BEFORE_MS;
      scheduledTimeout = setTimeout(evaluate, Math.min(Math.max(nextCheckInMs, 0), MAX_TIMEOUT_MS));
    }

    evaluate();

    // Covers sleep/wake and a long-backgrounded tab: re-evaluate against
    // the real clock the moment the tab becomes visible/focused again,
    // rather than waiting for whatever the (possibly throttled) scheduled
    // timeout gets around to.
    document.addEventListener("visibilitychange", evaluate);
    window.addEventListener("focus", evaluate);
    const safetyNet = setInterval(evaluate, SAFETY_NET_INTERVAL_MS);

    return () => {
      if (scheduledTimeout) clearTimeout(scheduledTimeout);
      document.removeEventListener("visibilitychange", evaluate);
      window.removeEventListener("focus", evaluate);
      clearInterval(safetyNet);
    };
  }, [expiresAt, signOutNow]);

  if (!showWarning || !expiresAt) return null;

  const remainingMinutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));

  return (
    <Dialog open={showWarning} onOpenChange={(open) => !open && setShowWarning(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Η συνεδρία σας λήγει σύντομα</DialogTitle>
          <DialogDescription>
            {remainingMinutes <= 1
              ? "Η συνεδρία σας θα λήξει σε λιγότερο από 1 λεπτό."
              : `Η συνεδρία σας θα λήξει σε ${remainingMinutes} λεπτά.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => setShowWarning(false)}>
            Συνέχεια εργασίας
          </Button>
          <Button variant="destructive" onClick={() => signOutNow("manual")}>
            Αποσύνδεση τώρα
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
