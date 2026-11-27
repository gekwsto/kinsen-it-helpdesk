"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { adminLoginSchema } from "@/lib/validations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, Loader2, ShieldCheck } from "lucide-react";

const ERROR_MESSAGES: Record<string, string> = {
  admin_only: "This login is for admin accounts only.",
  inactive_user: "Your account has been deactivated. Contact IT support.",
  credentials: "Invalid credentials.",
};

/**
 * `successUrl` / `defaultEmail` are used only by the session-renewal popup
 * (app/auth/session-renew/credentials) — the normal /login page passes
 * neither and keeps its exact previous behaviour.
 */
export function CredentialsLoginForm({ successUrl = "/dashboard", defaultEmail }: { successUrl?: string; defaultEmail?: string } = {}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  // Credentials must NEVER leave the browser before React has attached the
  // onSubmit handler: a <form> without method/action falls back to a native
  // GET to the current URL, putting the email/password into the query
  // string (URL, browser history, server/proxy logs). So the submit button
  // stays disabled until hydration (which also blocks implicit Enter-key
  // submission — a form with a disabled default button can't be implicitly
  // submitted), and the form itself declares secure POST semantics
  // targeting the existing NextAuth credentials endpoint as a last-resort
  // fallback: a native submission (no JavaScript) sends the credentials
  // only in the POST body and NextAuth rejects it for the missing CSRF
  // token — no parallel authentication path.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsPending(true);

    const data = new FormData(e.currentTarget);
    const parsed = adminLoginSchema.safeParse({
      email: data.get("email"),
      password: data.get("password"),
    });

    if (!parsed.success) {
      setError("Please enter a valid email and password.");
      setIsPending(false);
      return;
    }

    const result = await signIn("credentials", {
      email: parsed.data.email,
      password: parsed.data.password,
      redirect: false,
    });

    // Session renewal only: a sign-in with a DIFFERENT account is rejected
    // by the renewal identity check (lib/session-renewal.ts) — report it on
    // the renewal landing page so every waiting tab gets a clear message.
    if ((result?.error === "different_account" || result?.error === "renewal_expired") && successUrl.startsWith("/auth/session-renewed")) {
      router.push(`/auth/session-renewed?error=${result.error}`);
      return;
    }

    if (!result || result.error) {
      const code = result?.code ?? "credentials";
      setError(ERROR_MESSAGES[code] ?? "Invalid credentials.");
      setIsPending(false);
      return;
    }

    // Middleware handles mustChangePassword → /settings/change-password redirect
    router.push(successUrl);
  }

  return (
    <form
      method="post"
      action="/api/auth/callback/credentials"
      onSubmit={handleSubmit}
      className="space-y-3"
      data-hydrated={hydrated ? "true" : "false"}
    >
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="credentials-email" className="text-xs font-medium">
          Admin Email
        </Label>
        <Input
          id="credentials-email"
          name="email"
          defaultValue={defaultEmail}
          type="email"
          placeholder="admin@kinsen.gr"
          autoComplete="email"
          required
          disabled={isPending}
          className="h-9 text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="credentials-password" className="text-xs font-medium">
          Password
        </Label>
        <Input
          id="credentials-password"
          name="password"
          type="password"
          placeholder="••••••••"
          autoComplete="current-password"
          required
          disabled={isPending}
          className="h-9 text-sm"
        />
      </div>

      <Button
        type="submit"
        variant="outline"
        className="w-full h-9 gap-2 border-slate-300 text-sm"
        disabled={isPending || !hydrated}
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        {isPending ? "Signing in…" : "Sign in as Admin"}
      </Button>
    </form>
  );
}
