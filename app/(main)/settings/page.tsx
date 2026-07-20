import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getInitials, formatDateTime } from "@/lib/utils";
import { Role, AuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { KeyRound } from "lucide-react";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  IT_AGENT: "IT Agent",
  DEPARTMENT_MANAGER: "Department Manager",
  DIRECTOR: "Director",
  USER: "User",
};

const ROLE_COLORS: Record<Role, string> = {
  ADMIN: "bg-red-100 text-red-700",
  IT_AGENT: "bg-blue-100 text-blue-700",
  DEPARTMENT_MANAGER: "bg-purple-100 text-purple-700",
  DIRECTOR: "bg-indigo-100 text-indigo-700",
  USER: "bg-gray-100 text-gray-700",
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      department: { select: { id: true, name: true } },
      businessUnit: { select: { id: true, name: true } },
      subDepartment: { select: { id: true, name: true } },
      company: { select: { id: true, name: true } },
    },
  });

  if (!user) redirect("/login");

  const isCredentialsAdmin =
    user.role === Role.ADMIN && user.authProvider === AuthProvider.CREDENTIALS;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">Your profile and account settings</p>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>
            {isCredentialsAdmin
              ? "Your admin account is managed locally."
              : "Your profile information is managed through Microsoft Entra ID."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user.image ?? undefined} alt={user.name ?? "User"} />
              <AvatarFallback className="text-lg">
                {getInitials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-lg font-semibold">{user.name}</p>
              <p className="text-muted-foreground">{user.email}</p>
              <span
                className={`mt-1.5 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${ROLE_COLORS[user.role]}`}
              >
                {ROLE_LABELS[user.role]}
              </span>
            </div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 gap-4 text-sm">
            {user.company && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Company</p>
                <p className="font-medium">{user.company.name}</p>
              </div>
            )}
            {user.businessUnit && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Business Unit</p>
                <p className="font-medium">{user.businessUnit.name}</p>
              </div>
            )}
            {user.department && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Department</p>
                <p className="font-medium">{user.department.name}</p>
              </div>
            )}
            {user.subDepartment && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">Sub-Department</p>
                <p className="font-medium">{user.subDepartment.name}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Account Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Account Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Member since</span>
            <span className="font-medium">{formatDateTime(user.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Last updated</span>
            <span className="font-medium">{formatDateTime(user.updatedAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Account status</span>
            <span className={`font-medium ${user.isActive ? "text-green-600" : "text-red-600"}`}>
              {user.isActive ? "Active" : "Inactive"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Authentication</span>
            <span className="font-medium">
              {user.authProvider === AuthProvider.CREDENTIALS
                ? "Admin Credentials"
                : "Microsoft SSO"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Password Change (CREDENTIALS admins only) */}
      {isCredentialsAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Admin Password</CardTitle>
            <CardDescription>
              Manage the password for your admin credentials account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="gap-2">
              <Link href="/settings/change-password">
                <KeyRound className="h-4 w-4" />
                Change Password
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Support Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">IT Support Contact</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p className="text-muted-foreground">
            For IT support, create a ticket or contact us directly:
          </p>
          <p>
            Email:{" "}
            <a
              href="mailto:kinsenitsupport@kinsen.gr"
              className="text-primary hover:underline"
            >
              kinsenitsupport@kinsen.gr
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
