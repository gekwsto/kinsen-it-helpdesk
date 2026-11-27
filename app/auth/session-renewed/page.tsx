import { auth } from "@/lib/auth";
import { sanitizeInternalDestination } from "@/lib/safe-redirect";
import { SessionRenewedNotifier } from "@/components/auth/session-renewed-notifier";

/**
 * Landing page of a session renewal (app/auth/session-renew). Server-side:
 * reads the AUTHORITATIVE session (fresh cookie after a successful
 * re-authentication) and hands its user id + absolute expiry to the client
 * notifier, which announces it to every open tab and closes the popup.
 */
export default async function SessionRenewedPage({ searchParams }: { searchParams: Promise<{ error?: string; returnTo?: string }> }) {
  const session = await auth();
  const { error, returnTo } = await searchParams;
  const userId = session?.user?.id ?? null;
  const expiresAt = session?.user?.absoluteSessionExpiresAt ?? null;
  return (
    <SessionRenewedNotifier
      userId={userId}
      absoluteSessionExpiresAt={typeof expiresAt === "number" ? expiresAt : null}
      error={error ?? (userId && expiresAt ? null : "renewal_failed")}
      returnTo={returnTo ? sanitizeInternalDestination(returnTo, "/dashboard") : null}
    />
  );
}
