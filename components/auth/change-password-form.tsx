"use client";

import { useActionState } from "react";
import { useEffect } from "react";
import { signOut } from "next-auth/react";
import { changePasswordAction } from "@/lib/actions/change-password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle, CheckCircle2, Loader2, Lock } from "lucide-react";

interface ChangePasswordFormProps {
  isForcedChange?: boolean;
}

export function ChangePasswordForm({ isForcedChange = false }: ChangePasswordFormProps) {
  const [state, action, isPending] = useActionState(changePasswordAction, null);

  // After success: sign out to force JWT refresh with mustChangePassword = false
  useEffect(() => {
    if (state?.success) {
      signOut({ callbackUrl: "/login?message=password_changed" });
    }
  }, [state?.success]);

  const fieldError = (field: string) => state?.fieldErrors?.[field]?.[0];

  return (
    <form action={action} className="space-y-5">
      {state?.error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}

      {state?.success && (
        <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-700">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Password changed. Signing you out…</span>
        </div>
      )}

      {isForcedChange && !state?.success && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">
          You must change your password before continuing.
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="currentPassword">Current Password</Label>
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={isPending || !!state?.success}
          className={fieldError("currentPassword") ? "border-destructive" : ""}
        />
        {fieldError("currentPassword") && (
          <p className="text-xs text-destructive">{fieldError("currentPassword")}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="newPassword">New Password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={isPending || !!state?.success}
          className={fieldError("newPassword") ? "border-destructive" : ""}
        />
        {fieldError("newPassword") ? (
          <p className="text-xs text-destructive">{fieldError("newPassword")}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Min 8 chars · uppercase · lowercase · number · special character
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm New Password</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={isPending || !!state?.success}
          className={fieldError("confirmPassword") ? "border-destructive" : ""}
        />
        {fieldError("confirmPassword") && (
          <p className="text-xs text-destructive">{fieldError("confirmPassword")}</p>
        )}
      </div>

      <Button
        type="submit"
        className="w-full gap-2"
        disabled={isPending || !!state?.success}
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Lock className="h-4 w-4" />
        )}
        {isPending ? "Changing password…" : "Change Password"}
      </Button>
    </form>
  );
}
