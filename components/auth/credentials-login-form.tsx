"use client";

import { useState } from "react";
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

export function CredentialsLoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

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

    if (!result || result.error) {
      const code = result?.code ?? "credentials";
      setError(ERROR_MESSAGES[code] ?? "Invalid credentials.");
      setIsPending(false);
      return;
    }

    // Middleware handles mustChangePassword → /settings/change-password redirect
    router.push("/dashboard");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
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
        disabled={isPending}
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
