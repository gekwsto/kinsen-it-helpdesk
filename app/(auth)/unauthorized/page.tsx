import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldX } from "lucide-react";

export default async function UnauthorizedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const isDomainError = reason === "domain";

  return (
    <div className="w-full max-w-md px-4">
      <Card className="border-0 shadow-2xl text-center">
        <CardHeader className="pb-4">
          <div className="flex justify-center mb-4">
            <div className="h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <ShieldX className="h-8 w-8 text-destructive" />
            </div>
          </div>
          <CardTitle className="text-xl">Access Denied</CardTitle>
          <CardDescription>
            {isDomainError
              ? "Your account email domain is not authorized to access this system."
              : "You are not authorized to access this resource."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isDomainError && (
            <div className="rounded-lg bg-muted px-4 py-3 text-sm text-muted-foreground">
              Only <span className="font-medium text-foreground">@kinsen.gr</span> email accounts
              are permitted to sign in. Please use your company Microsoft account.
            </div>
          )}
          <Button asChild className="w-full">
            <Link href="/login">Back to Login</Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            If you believe this is an error, please contact the IT department.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
