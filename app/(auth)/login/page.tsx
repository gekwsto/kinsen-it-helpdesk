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
        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary mb-4">
          <Headset className="h-8 w-8 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-white">Kinsen IT Helpdesk</h1>
        <p className="text-slate-400 mt-1">Internal IT Support System</p>
      </div>

      <Card className="border-0 shadow-2xl">
        <CardHeader className="text-center pb-4">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>
            Sign in with your Kinsen Microsoft account to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {message === "password_changed" && (
            <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-700">
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

          <p className="text-center text-xs text-muted-foreground">
            Access is restricted to{" "}
            <span className="font-medium text-foreground">@kinsen.gr</span> accounts only.
          </p>

          {/* Divider */}
          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">admin access</span>
            <Separator className="flex-1" />
          </div>

          {/* Secondary: Credentials for ADMIN only */}
          <CredentialsLoginForm />
        </CardContent>
      </Card>

      <p className="text-center text-xs text-slate-500 mt-6">
        © {new Date().getFullYear()} Kinsen. All rights reserved.
      </p>
    </div>
  );
}
