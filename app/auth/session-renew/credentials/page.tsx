import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { CredentialsLoginForm } from "@/components/auth/credentials-login-form";

/**
 * Session renewal for credentials (admin) accounts — the existing
 * credentials form, pre-filled with the signed-in user's email. A
 * successful sign-in issues a fresh session (new absolute expiry) and lands
 * on /auth/session-renewed; signing in as anyone else is rejected by the
 * renewal identity check (lib/session-renewal.ts).
 */
export default async function SessionRenewCredentialsPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login?message=session_expired");
  const { next } = await searchParams;
  const successUrl = next && next.startsWith("/auth/session-renewed") ? next : "/auth/session-renewed";
  return (
    <div className="mx-auto mt-16 w-full max-w-sm space-y-4 px-4">
      <div>
        <h1 className="text-lg font-semibold">Ανανέωση συνεδρίας</h1>
        <p className="text-sm text-muted-foreground">Συνδεθείτε ξανά για να συνεχίσετε την εργασία σας.</p>
      </div>
      <CredentialsLoginForm successUrl={successUrl} defaultEmail={session.user.email ?? undefined} />
    </div>
  );
}
