/**
 * Session renewal by RE-AUTHENTICATION (Node runtime only).
 *
 * Policy (unchanged): the application session is ABSOLUTE — 8h from a real
 * sign-in, never extended by activity (lib/session-expiry.ts). "Renewal" is
 * therefore a genuine new sign-in through the existing flows (Microsoft
 * Entra ID, or the admin credentials login), which Auth.js turns into a
 * brand-new token that lib/auth.ts's jwt callback stamps with a fresh
 * absolute expiry. Nothing here extends an existing expiry.
 *
 * Identity binding: while a renewal is in progress the browser still holds
 * the CURRENT user's valid session cookie. Auth.js would then (a) link a
 * not-yet-linked OAuth account to that current user, or (b) silently swap
 * the browser to whichever account signed in. To prevent both, starting a
 * renewal sets a short-lived httpOnly cookie naming the expected user, and
 * lib/auth.ts's signIn callback rejects any sign-in during a renewal that
 * is not that same user — BEFORE Auth.js links accounts or issues a cookie,
 * so the existing session stays intact.
 */
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/services/email-identity";
import { readRawSessionExpiryState } from "@/lib/session-expiry";

export const SESSION_RENEWAL_COOKIE = "kinsen-session-renewal";
/** Long enough to finish a Microsoft/credentials sign-in, short enough to never outlive the renewal attempt. */
export const SESSION_RENEWAL_MAX_AGE_MS = 10 * 60 * 1000;
const SESSION_RENEWAL_COOKIE_MAX_AGE_SECONDS = SESSION_RENEWAL_MAX_AGE_MS / 1000;

/**
 * Marker value: `<userId>.<issuedAtMs>`. The browser drops it after maxAge,
 * and the SERVER independently refuses it once older than
 * SESSION_RENEWAL_MAX_AGE_MS (never relying on the browser alone). It
 * carries no authority: it can only RESTRICT a sign-in to the named user,
 * never grant anything — so a tampered or replayed value can at most cause
 * a refused sign-in.
 */
export function encodeSessionRenewalMarker(userId: string, issuedAtMs: number = Date.now()): string {
  return `${userId}.${issuedAtMs}`;
}

export function parseSessionRenewalMarker(value: string, nowMs: number = Date.now()): { userId: string } | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const issuedAt = Number(value.slice(dot + 1));
  if (!Number.isFinite(issuedAt) || issuedAt > nowMs + 60_000) return null;
  if (nowMs - issuedAt > SESSION_RENEWAL_MAX_AGE_MS) return null;
  return { userId };
}

export async function beginSessionRenewal(userId: string): Promise<void> {
  (await cookies()).set(SESSION_RENEWAL_COOKIE, encodeSessionRenewalMarker(userId), {
    httpOnly: true,
    sameSite: "lax", // sent on the top-level OAuth callback redirect
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_RENEWAL_COOKIE_MAX_AGE_SECONDS,
  });
}

export type SessionRenewalIdentityCheck = { renewing: false } | { renewing: true; sameUser: boolean; expired?: boolean };

/**
 * Called from the signIn callback. Not renewing -> no effect on normal
 * sign-in. Renewing -> `sameUser` only when the signing-in identity is the
 * user who started the renewal (by id when Auth.js already resolved the DB
 * user, else by normalized email — the identity this app keys users on).
 * The marker is consumed either way, so a retry starts cleanly.
 */
export async function checkSessionRenewalIdentity(user: { id?: string | null; email?: string | null }): Promise<SessionRenewalIdentityCheck> {
  const jar = await cookies();
  const raw = jar.get(SESSION_RENEWAL_COOKIE)?.value;
  if (!raw) return { renewing: false };
  // Consumed on first use — a marker can never be replayed for a second sign-in.
  jar.delete(SESSION_RENEWAL_COOKIE);
  // The marker only protects a sign-in made while a session is PRESENT
  // (that's when Auth.js could link accounts or swap the session). With no
  // session cookie at all (signed out, or the session already expired and
  // was cleared) there is nothing to protect: the leftover marker is inert,
  // so it can never affect the next person signing in on this browser.
  const current = await readRawSessionExpiryState({ headers: await headers() });
  if (!current.hasToken) return { renewing: false };
  const marker = parseSessionRenewalMarker(raw);
  // Expired / malformed marker: fail SAFE (refuse), never fall back to a
  // normal sign-in while a renewal was in progress.
  if (!marker) return { renewing: true, sameUser: false, expired: true };
  const expected = await prisma.user.findUnique({ where: { id: marker.userId }, select: { id: true, email: true, isActive: true } });
  if (!expected || !expected.isActive) return { renewing: true, sameUser: false };
  const sameUser = user.id === expected.id || (!!user.email && normalizeEmail(user.email) === normalizeEmail(expected.email));
  return { renewing: true, sameUser };
}

/** Clears any pending renewal marker (called on sign-out, so a lingering marker can't affect the next sign-in on this browser). */
export async function clearSessionRenewal(): Promise<void> {
  try {
    (await cookies()).delete(SESSION_RENEWAL_COOKIE);
  } catch {
    // Outside a request scope — nothing to clear.
  }
}
