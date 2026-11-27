"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getSessionSyncChannel, broadcastLogout, type SessionSyncMessage } from "@/lib/client-session-broadcast";
import { computeSessionExpiryUiState, isValidSessionRenewal, SESSION_FINAL_NOTICE_BEFORE_MS, SESSION_WARNING_BEFORE_MS } from "@/lib/session-expiry";

/**
 * Safety-net recheck interval, alongside the scheduled timeouts below and
 * the visibilitychange/focus listeners — belt-and-braces against a browser
 * throttling/coalescing a background tab's timer without firing a
 * visibilitychange/focus event first (observed engine-specific behavior,
 * not hypothetical) or a scheduled timeout otherwise not firing exactly on
 * time. Cheap (a single Date.now() comparison), so a short interval costs
 * nothing. It only RE-EVALUATES the authoritative expiry — it never
 * requests anything from the server.
 */
const SAFETY_NET_INTERVAL_MS = 15_000;

/** setTimeout delays beyond ~24.8 days silently fire immediately in some engines — irrelevant at an 8h maximum, capped defensively anyway since it's free. */
const MAX_TIMEOUT_MS = 2_147_483_000;

const RENEWAL_POPUP_NAME = "kinsen-session-renewal";

type RenewalState =
  | { phase: "idle" }
  | { phase: "awaiting" } // popup open, user re-authenticating
  | { phase: "validating" } // re-reading + validating the server session
  | { phase: "error"; message: string; allowSameTab?: boolean };

const RENEWAL_ERROR_TEXT: Record<string, string> = {
  popup_blocked: "Δεν ήταν δυνατό να ανοίξει το παράθυρο σύνδεσης (ο browser το μπλόκαρε). Επιτρέψτε τα αναδυόμενα παράθυρα ή συνδεθείτε ξανά σε αυτή την καρτέλα.",
  different_account: "Η σύνδεση έγινε με διαφορετικό λογαριασμό. Η συνεδρία σας δεν ανανεώθηκε.",
  renewal_failed: "Η ανανέωση της συνεδρίας απέτυχε. Δοκιμάστε ξανά ή συνδεθείτε από την αρχή.",
  renewal_expired: "Το αίτημα ανανέωσης έληξε. Πατήστε ξανά «Συνέχεια εργασίας».",
};

/**
 * Central, single session-expiration controller — mounted ONCE in
 * app/(main)/layout.tsx, never per-page. Reads the AUTHORITATIVE
 * `absoluteSessionExpiresAt` the server stamped at sign-in (lib/auth.ts's
 * jwt/session callbacks — never recomputed or extended here). The actual
 * enforcement happens server-side (lib/auth.config.ts `authorized` +
 * lib/auth.ts jwt callback) regardless of this component.
 *
 * Session policy: ABSOLUTE 8h from a real sign-in, never extended by
 * activity. "Συνέχεια εργασίας" therefore renews by RE-AUTHENTICATION
 * (lib/session-renewal.ts): it opens the existing sign-in flow in a popup
 * (this page — and any unsaved form data — stays untouched); a successful
 * sign-in issues a fresh session with a new absolute expiry; the popup
 * announces it on the session-sync channel; EVERY tab then re-reads its
 * session from the server (`update()`) and only accepts it when it is the
 * same user with a later, still-valid expiry. Only then does the warning
 * close — and because the timers are keyed on the authoritative expiry,
 * the new expiry resets them and the old one can never re-trigger.
 */
export function SessionExpiryController() {
  const { data: session, update } = useSession();
  const expiresAt = session?.user?.absoluteSessionExpiresAt ?? null;
  const userId = session?.user?.id ?? null;

  const [showWarning, setShowWarning] = useState(false);
  const [renewal, setRenewal] = useState<RenewalState>({ phase: "idle" });
  const hasActedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const popupRef = useRef<Window | null>(null);
  const validatingRef = useRef(false);
  // The warning dismissed with ✕ stays closed for THIS expiry until the final notice window.
  const dismissedForExpiryRef = useRef<number | null>(null);
  // Latest values for the (registered-once) channel listener.
  const latestRef = useRef({ expiresAt, userId, update });
  latestRef.current = { expiresAt, userId, update };

  const signOutNow = useCallback((reason: "expired" | "manual") => {
    if (hasActedRef.current) return;
    hasActedRef.current = true;
    setShowWarning(false);
    broadcastLogout(channelRef.current);
    try { popupRef.current?.close(); } catch { /* ignore */ }
    void signOut({ callbackUrl: reason === "expired" ? "/login?message=session_expired" : "/login" });
  }, []);

  /**
   * Re-reads the session from the SERVER and accepts it only if it is a
   * genuine renewal (same user, later + still-valid absolute expiry). One
   * in-flight validation per tab.
   */
  const validateRenewedSession = useCallback(async () => {
    if (validatingRef.current || hasActedRef.current) return;
    validatingRef.current = true;
    const { expiresAt: previousExpiresAt, userId: previousUserId, update: refresh } = latestRef.current;
    setRenewal((r) => (r.phase === "idle" ? r : { phase: "validating" }));
    try {
      const fresh = await refresh();
      const freshUserId = fresh?.user?.id ?? null;
      const freshExpiresAt = fresh?.user?.absoluteSessionExpiresAt ?? null;
      if (freshUserId && previousUserId && freshUserId !== previousUserId) {
        // The browser's session now belongs to someone else — never keep
        // showing this user's data. (The renewal identity check normally
        // prevents this; this is defence in depth.)
        window.location.reload();
        return;
      }
      if (isValidSessionRenewal(previousExpiresAt, freshExpiresAt)) {
        dismissedForExpiryRef.current = null;
        setRenewal({ phase: "idle" });
        setShowWarning(false);
      } else {
        setRenewal((r) => (r.phase === "idle" ? r : { phase: "error", message: RENEWAL_ERROR_TEXT.renewal_failed, allowSameTab: true }));
      }
    } catch {
      setRenewal((r) => (r.phase === "idle" ? r : { phase: "error", message: RENEWAL_ERROR_TEXT.renewal_failed, allowSameTab: true }));
    } finally {
      validatingRef.current = false;
    }
  }, []);

  // Cross-tab sync — ONE listener for the component's lifetime (latest
  // values read through refs), independent of whether the session has
  // loaded, so a tab still fetching its own session still reacts.
  useEffect(() => {
    const channel = getSessionSyncChannel();
    channelRef.current = channel;
    if (!channel) return;
    const onMessage = (event: MessageEvent<SessionSyncMessage>) => {
      const message = event.data;
      if (message?.type === "LOGOUT" && !hasActedRef.current) {
        hasActedRef.current = true;
        setShowWarning(false);
        void signOut({ callbackUrl: "/login" });
      } else if (message?.type === "SESSION_RENEWED") {
        // Only a trigger: the authoritative session is re-read and validated.
        if (message.absoluteSessionExpiresAt !== latestRef.current.expiresAt) void validateRenewedSession();
      } else if (message?.type === "SESSION_RENEWAL_FAILED") {
        setRenewal((r) => (r.phase === "idle" ? r : { phase: "error", message: RENEWAL_ERROR_TEXT[message.reason] ?? RENEWAL_ERROR_TEXT.renewal_failed, allowSameTab: true }));
      }
    };
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, [validateRenewedSession]);

  useEffect(() => {
    if (!expiresAt) return;
    hasActedRef.current = false;

    let scheduledTimeout: ReturnType<typeof setTimeout> | null = null;

    // Always a fresh `Date.now()` vs. the authoritative `expiresAt` (never
    // a value from before a renewal — this effect re-runs, with fresh
    // timers/listeners, whenever the authoritative expiry changes).
    function evaluate() {
      if (hasActedRef.current) return;
      const { action, remainingMs } = computeSessionExpiryUiState(expiresAt!);

      if (action === "signout") {
        signOutNow("expired");
        return;
      }

      const dismissed = dismissedForExpiryRef.current === expiresAt && remainingMs > SESSION_FINAL_NOTICE_BEFORE_MS;
      setShowWarning(action === "warn" && !dismissed);

      if (scheduledTimeout) clearTimeout(scheduledTimeout);
      const nextCheckInMs =
        action === "warn" ? (dismissed ? remainingMs - SESSION_FINAL_NOTICE_BEFORE_MS : remainingMs) : remainingMs - SESSION_WARNING_BEFORE_MS;
      scheduledTimeout = setTimeout(evaluate, Math.min(Math.max(nextCheckInMs, 0), MAX_TIMEOUT_MS));
    }

    evaluate();

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

  const startRenewal = () => {
    // Repeated clicks never start a second renewal: an open popup is just focused.
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus();
      return;
    }
    const popup = window.open("/auth/session-renew", RENEWAL_POPUP_NAME, "popup,width=520,height=720");
    if (!popup) {
      setRenewal({ phase: "error", message: RENEWAL_ERROR_TEXT.popup_blocked, allowSameTab: true });
      return;
    }
    popupRef.current = popup;
    setRenewal({ phase: "awaiting" });
  };

  const renewInThisTab = () => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.assign(`/auth/session-renew?returnTo=${encodeURIComponent(returnTo)}`);
  };

  if (!showWarning || !expiresAt) return null;

  const remainingMinutes = Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000));
  const busy = renewal.phase === "validating";

  return (
    <Dialog
      open={showWarning}
      onOpenChange={(open) => {
        if (!open) {
          // ✕ / Escape: hides the warning for THIS expiry until the final notice — never a renewal.
          dismissedForExpiryRef.current = expiresAt;
          setShowWarning(false);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Η συνεδρία σας λήγει σύντομα</DialogTitle>
          <DialogDescription>
            {remainingMinutes <= 1
              ? "Η συνεδρία σας θα λήξει σε λιγότερο από 1 λεπτό."
              : `Η συνεδρία σας θα λήξει σε ${remainingMinutes} λεπτά.`}{" "}
            Για να συνεχίσετε, επιβεβαιώστε ξανά τη σύνδεσή σας — η τρέχουσα σελίδα και οι αλλαγές σας παραμένουν.
          </DialogDescription>
        </DialogHeader>
        {renewal.phase === "awaiting" && (
          <p className="text-sm text-muted-foreground" data-testid="session-renewal-status">
            Ολοκληρώστε τη σύνδεση στο παράθυρο που άνοιξε.
          </p>
        )}
        {renewal.phase === "error" && (
          <div className="space-y-2" data-testid="session-renewal-error">
            <p className="text-sm text-destructive">{renewal.message}</p>
            {renewal.allowSameTab && (
              <Button variant="link" className="h-auto p-0 text-sm" onClick={renewInThisTab}>
                Σύνδεση ξανά σε αυτή την καρτέλα (μη αποθηκευμένες αλλαγές θα χαθούν)
              </Button>
            )}
          </div>
        )}
        <DialogFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={startRenewal} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
