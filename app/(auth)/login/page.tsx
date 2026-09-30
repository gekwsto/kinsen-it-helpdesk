import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth, signIn, signOut } from "@/lib/auth";
import { readRawSessionExpiryState } from "@/lib/session-expiry";
import { sanitizeInternalDestination } from "@/lib/safe-redirect";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CredentialsLoginForm } from "@/components/auth/credentials-login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session) redirect("/dashboard");

  const { message, callbackUrl } = await searchParams;

  // Server-confirmed, independent of `message` — the query string is only
  // ever used below for the cosmetic banner text. Whether the Microsoft
  // sign-in button forces `prompt=login` is decided ONLY from this direct
  // read of the actual session cookie (the same classification
  // app/auth/sso-entry/route.ts uses), so a forged `?message=session_expired`
  // can never force reauthentication, and a forged absence of it can never
  // suppress it for a session that genuinely is expired.
  const rawState = await readRawSessionExpiryState({ headers: await headers() });
  const forceReauth = rawState.hasToken && rawState.isExpired;
  const destination = sanitizeInternalDestination(callbackUrl, "/dashboard");

  // Plain external arrival (no session, nothing that needs explaining to
  // the user) — forward straight to the canonical SSO entry point
  // (app/auth/sso-entry/route.ts) for a genuinely silent flow: no button
  // click, no intermediate page. This is what makes a redirect from the
  // company suite — which today still lands here as
  // /login?callbackUrl=... rather than on /auth/sso-entry directly, and
  // Auth.js's own default unauthorized-redirect (middleware bouncing an
  // unauthenticated hit on a protected page) does the exact same thing —
  // behave as silent SSO instead of requiring an explicit click. Gated on
  // `callbackUrl` being present, not just "no session": a bare,
  // intentional visit to /login (no query string at all) still renders
  // the page normally, so the admin-only credentials form below stays
  // reachable.
  if (!forceReauth && !message && callbackUrl) {
    redirect(`/auth/sso-entry?returnTo=${encodeURIComponent(destination)}`);
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Use your Kinsen Microsoft account to continue.
      </p>

      <div className="mt-8 space-y-5">
        {message === "password_changed" && (
          <div role="status" className="rounded border border-border bg-card px-3 py-2.5 text-sm">
            Password changed. Please sign in with your new password.
          </div>
        )}

        {message === "session_expired" && (
          <div role="status" className="rounded border border-border bg-card px-3 py-2.5 text-sm">
            Your session ended after 8 hours. Please sign in again.
          </div>
        )}

        {/* Primary: Microsoft SSO */}
        <form
          action={async () => {
            "use server";
            // `forceReauth`/`destination` are plain primitives captured
            // from this Server Component's own render — both computed
            // server-side above, never from a client-controlled flag.
            if (forceReauth) {
              // Same reasoning as app/auth/sso-entry/route.ts: clear the
              // stale, already-expired cookie before requesting a fresh
              // one, so the reauthenticated session gets its own
              // independent 8h window instead of risking inheriting the
              // already-past absoluteSessionExpiresAt from the old token.
              await signOut({ redirect: false });
              await signIn("microsoft-entra-id", { redirectTo: destination }, { prompt: "login" });
            } else {
              await signIn("microsoft-entra-id", { redirectTo: destination });
            }
          }}
        >
          <Button type="submit" className="w-full gap-3" size="lg">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 21 21">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" />
              <rect x="11" y="1" width="9" height="9" fill="#00a4ef" />
              <rect x="1" y="11" width="9" height="9" fill="#7fba00" />
              <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Sign in with Microsoft
          </Button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          Access is restricted to{" "}
          <span className="font-medium text-foreground">@kinsen.gr</span> accounts.
        </p>

        <div className="flex items-center gap-3 pt-2">
          <Separator className="flex-1" />
          <span className="text-xs text-muted-foreground">admin access</span>
          <Separator className="flex-1" />
        </div>

        {/* Secondary: Credentials for ADMIN only */}
        <CredentialsLoginForm />
      </div>

      <p className="mt-10 text-xs text-muted-foreground">
        © {new Date().getFullYear()} Kinsen. All rights reserved.
      </p>
    </div>
  );
}
