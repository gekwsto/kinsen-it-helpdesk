"use client";

import { useEffect, useRef } from "react";
import { broadcastSessionRenewalFailed, broadcastSessionRenewed, getSessionSyncChannel } from "@/lib/client-session-broadcast";

const ERROR_TEXT: Record<string, string> = {
  different_account: "Η σύνδεση έγινε με διαφορετικό λογαριασμό. Η συνεδρία σας δεν ανανεώθηκε.",
  renewal_failed: "Η ανανέωση της συνεδρίας απέτυχε.",
  renewal_expired: "Το αίτημα ανανέωσης έληξε. Ξεκινήστε την ανανέωση ξανά από την εφαρμογή.",
};

/**
 * Runs once on /auth/session-renewed: announces the outcome to every open
 * tab (they each re-validate against the server — this message is only a
 * trigger), then closes the popup. In the same-tab fallback (no opener) it
 * returns to the page the user came from.
 */
export function SessionRenewedNotifier({
  userId,
  absoluteSessionExpiresAt,
  error,
  returnTo,
}: {
  userId: string | null;
  absoluteSessionExpiresAt: number | null;
  error: string | null;
  returnTo: string | null;
}) {
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const channel = getSessionSyncChannel();
    if (error || !userId || !absoluteSessionExpiresAt) {
      broadcastSessionRenewalFailed(channel, error ?? "renewal_failed");
    } else {
      broadcastSessionRenewed(channel, userId, absoluteSessionExpiresAt);
    }
    channel?.close();
    if (window.opener && !window.opener.closed) {
      if (!error) window.close();
    } else if (!error) {
      window.location.replace(returnTo ?? "/dashboard");
    }
  }, [userId, absoluteSessionExpiresAt, error, returnTo]);

  return (
    <div className="mx-auto mt-16 w-full max-w-sm space-y-2 px-4 text-center">
      {error ? (
        <>
          <h1 className="text-lg font-semibold">Η ανανέωση δεν ολοκληρώθηκε</h1>
          <p className="text-sm text-muted-foreground" data-testid="renewal-error">{ERROR_TEXT[error] ?? ERROR_TEXT.renewal_failed}</p>
          <p className="text-sm text-muted-foreground">Μπορείτε να κλείσετε αυτό το παράθυρο.</p>
        </>
      ) : (
        <>
          <h1 className="text-lg font-semibold">Η συνεδρία ανανεώθηκε</h1>
          <p className="text-sm text-muted-foreground">Μπορείτε να κλείσετε αυτό το παράθυρο.</p>
        </>
      )}
    </div>
  );
}
