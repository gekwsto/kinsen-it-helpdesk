import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthProvider } from "@prisma/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";
import { ChangePasswordForm } from "@/components/auth/change-password-form";

export default async function ChangePasswordPage() {
  const session = await auth();

  if (!session?.user) redirect("/login");
  if (session.user.role !== Role.ADMIN) redirect("/settings");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { authProvider: true, mustChangePassword: true },
  });

  if (!user || user.authProvider !== AuthProvider.CREDENTIALS) redirect("/settings");

  return (
    <div className="space-y-6 max-w-md">
      <div>
        <h1 className="text-2xl font-bold">Change Password</h1>
        <p className="text-muted-foreground mt-1">
          Update the password for your admin account.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">Admin Account Password</CardTitle>
          </div>
          <CardDescription>
            Choose a strong password. You will be signed out after the change.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm isForcedChange={user.mustChangePassword} />
        </CardContent>
      </Card>
    </div>
  );
}
