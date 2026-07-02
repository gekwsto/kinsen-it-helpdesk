import { redirect } from "next/navigation";
import { auth, signIn } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Headset } from "lucide-react";
import { CredentialsLoginForm } from "@/components/auth/credentials-login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>;
}) {
  const session = await auth();
  if (session) redirect("/dashboard");

  const { message } = await searchParams;

  return (
    <div className="w-full max-w-md px-4">
      {/* Logo/Brand */}
      <div className="text-center mb-8">
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl mb-4 shadow-[0_0_0_1px_rgba(57,191,194,0.3),0_0_32px_rgba(57,191,194,0.15)]"
          style={{ backgroundColor: "#032e47" }}>
          <Headset className="h-8 w-8" style={{ color: "#39bfc2" }} />
        </div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Kinsen IT Helpdesk</h1>
        <p className="text-slate-400 mt-1 text-sm">Internal IT Support System</p>
      </div>

      {/* Glass card */}
      <Card
        className="border rounded-2xl"
        style={{
          backgroundColor: "rgba(7, 25, 41, 0.75)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          borderColor: "rgba(57, 191, 194, 0.15)",
          boxShadow:
            "0 0 0 1px rgba(255,255,255,0.05), 0 24px 64px -12px rgba(0,0,0,0.7), 0 0 40px rgba(57,191,194,0.06)",
        }}
      >
        <CardHeader className="text-center pb-4">
          <CardTitle className="text-xl text-white">Welcome back</CardTitle>
          <CardDescription className="text-slate-400">
            Sign in with your Kinsen Microsoft account to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {message === "password_changed" && (
            <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2.5 text-sm text-green-400">
              Password changed. Please sign in with your new password.
            </div>
          )}

          {/* Primary: Microsoft SSO */}
          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: "/dashboard" });
            }}
          >
            <Button type="submit" className="w-full h-11 gap-3" size="lg">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 21 21">
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#00a4ef" />
                <rect x="1" y="11" width="9" height="9" fill="#7fba00" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
              Sign in with Microsoft
            </Button>
          </form>

          <p className="text-center text-xs text-slate-500">
            Access is restricted to{" "}
            <span className="font-medium text-slate-300">@kinsen.gr</span> accounts only.
          </p>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <Separator className="flex-1 bg-white/10" />
            <span className="text-xs text-slate-500">admin access</span>
            <Separator className="flex-1 bg-white/10" />
          </div>

          {/* Secondary: Credentials for ADMIN only */}
          <CredentialsLoginForm />
        </CardContent>
      </Card>

      <p className="text-center text-xs text-slate-600 mt-6">
        © {new Date().getFullYear()} Kinsen. All rights reserved.
      </p>
    </div>
  );
}
