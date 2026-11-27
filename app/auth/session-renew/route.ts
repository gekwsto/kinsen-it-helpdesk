import { NextRequest, NextResponse } from "next/server";
import { auth, signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sanitizeInternalDestination } from "@/lib/safe-redirect";
import { beginSessionRenewal } from "@/lib/session-renewal";

/**
 * GET /auth/session-renew — starts a session renewal by RE-AUTHENTICATION
 * (see lib/session-renewal.ts). Requires a currently valid session (the
 * middleware already redirects anyone without one to /login; re-checked
 * here). Opened in a popup by the session-expiry warning, so the user's
 * page and unsaved work stay untouched; `?returnTo=` is the same-tab
 * fallback when a popup can't be opened.
 *  - Microsoft users: the existing Entra ID sign-in, hinted to their own
 *    account (usually completes without a prompt while their Microsoft
 *    session is alive).
 *  - Credentials (admin) users: the existing credentials form.
 * Either way the result lands on /auth/session-renewed.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login?message=session_expired", req.nextUrl.origin));
  }
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, email: true, authProvider: true, isActive: true } });
  if (!user || !user.isActive) {
    return NextResponse.redirect(new URL("/auth/session-renewed?error=renewal_failed", req.nextUrl.origin));
  }

  const rawReturnTo = req.nextUrl.searchParams.get("returnTo");
  const returnTo = rawReturnTo ? sanitizeInternalDestination(rawReturnTo, "/dashboard") : null;
  const renewedUrl = `/auth/session-renewed${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;

  await beginSessionRenewal(user.id);

  if (user.authProvider === "CREDENTIALS") {
    return NextResponse.redirect(new URL(`/auth/session-renew/credentials?next=${encodeURIComponent(renewedUrl)}`, req.nextUrl.origin));
  }
  await signIn("microsoft-entra-id", { redirectTo: renewedUrl }, { login_hint: user.email });
}
