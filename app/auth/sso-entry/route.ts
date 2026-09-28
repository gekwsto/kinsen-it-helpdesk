import { NextRequest, NextResponse } from "next/server";
import { auth, signIn, signOut } from "@/lib/auth";
import { readRawSessionExpiryState } from "@/lib/session-expiry";
import { sanitizeInternalDestination } from "@/lib/safe-redirect";

/**
 * Canonical entry point for a redirect INTO the Helpdesk from the company
 * application suite — e.g. `/auth/sso-entry?returnTo=/tickets`. This is the
 * only place that classifies "valid / absent / expired" for this purpose;
 * every other consumer (app/(auth)/login/page.tsx's own direct-login button)
 * reuses the SAME `readRawSessionExpiryState` classification, never a
 * separate reimplementation.
 *
 * Reuses the EXISTING `auth()`/`signIn()`/`signOut()` (lib/auth.ts) and the
 * EXISTING Microsoft Entra OIDC provider (lib/auth.config.ts) verbatim — no
 * second authentication implementation. The only new behavior this route
 * adds is: (1) skip Microsoft entirely when already validly signed in, and
 * (2) pass `prompt=login` on the one specific authorization request issued
 * for a SERVER-CONFIRMED expired session — never read from a client-
 * supplied query parameter (see the classification step below).
 */
export async function GET(req: NextRequest) {
  // Validated FIRST and independently of session state — this is the only
  // place `returnTo` is ever trusted from, and it never influences which
  // branch below runs (only where a branch that decides to proceed
  // ultimately lands).
  const returnTo = sanitizeInternalDestination(req.nextUrl.searchParams.get("returnTo"));

  // 1. VALID session — the full auth() pipeline (lib/auth.ts's jwt/session
  // callbacks) already enforces isActive, org-domain eligibility, and the
  // absolute 8h expiry; a non-null result here means all of that already
  // passed. Straight to the destination, no Microsoft round-trip at all.
  const session = await auth();
  if (session?.user) {
    return NextResponse.redirect(new URL(returnTo, req.nextUrl.origin));
  }

  // auth() returned null for one of two reasons that look identical from
  // its own return value alone: never authenticated, or authenticated but
  // past the 8h absolute boundary (lib/auth.ts's jwt callback returns null
  // in both the "no token" and "expired token" cases). Recovering that
  // distinction needs the RAW, non-re-signing decode — see
  // readRawSessionExpiryState's own doc comment. This is a server-side
  // read of the actual session cookie; nothing here is ever taken from a
  // query parameter like `expired=true`/`forceLogin=true`, which a client
  // could freely forge in either direction.
  const rawState = await readRawSessionExpiryState(req);

  if (rawState.hasToken && rawState.isExpired) {
    // 3. EXPIRED session — explicitly invalidate the stale local session
    // before requesting a fresh one, exactly like the client-side proactive
    // path (components/auth/session-expiry-controller.tsx) already does on
    // its own detection of the same boundary. This also matters for
    // correctness, not just hygiene: leaving the expired cookie in place
    // risks Auth.js's callback handler reusing its already-past
    // `loginAt`/`absoluteSessionExpiresAt` for the NEW sign-in (the
    // stamping guard in lib/session-expiry.ts is a no-op once `loginAt` is
    // already set) — clearing it first guarantees the reauthenticated
    // session gets a genuinely fresh, independent 8h window.
    await signOut({ redirect: false });
    // `prompt=login` is added ONLY on this specific authorization request —
    // never globally on the provider config (lib/auth.config.ts), which
    // would break silent SSO for the first-time/no-session case below.
    await signIn("microsoft-entra-id", { redirectTo: returnTo }, { prompt: "login" });
    return; // unreachable — signIn() above always redirects (throws)
  }

  // 2. ABSENT session (never authenticated, or already fully signed out) —
  // the existing, normal Microsoft OIDC authorization flow, no `prompt`
  // override at all. Entra's own browser SSO decides, based on whatever
  // session it already has, whether to complete this silently or fall back
  // to its normal login page — unchanged, existing behavior.
  await signIn("microsoft-entra-id", { redirectTo: returnTo });
}
