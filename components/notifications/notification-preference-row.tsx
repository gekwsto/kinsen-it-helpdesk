"use client";

import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useServerBooleanPreference } from "@/hooks/use-server-boolean-preference";
import { cn } from "@/lib/utils";

interface NotificationPreferenceRowProps {
  apiPath: string;
  label: string;
  description: string;
  ariaLabel: string;
  errorMessage: string;
  className?: string;
}

/**
 * One label+description+Switch row for a self-only notification preference
 * — the single shared implementation both the bell dropdown
 * (notification-dropdown.tsx) and the Settings page's
 * NotificationPreferencesCard render, so the fetch/PATCH/error-toast logic
 * exists in exactly one place regardless of how many surfaces expose the
 * same preference. Renders nothing until the real value has loaded
 * (including its own wrapper — `className` is applied to that SAME
 * conditionally-rendered element, not a separate always-present shell), so
 * a caller never shows an empty bordered row before the fetch resolves.
 */
export function NotificationPreferenceRow({ apiPath, label, description, ariaLabel, errorMessage, className }: NotificationPreferenceRowProps) {
  const { enabled, saving, toggle } = useServerBooleanPreference(apiPath);
  if (enabled === null) return null;

  const handleToggle = async (next: boolean) => {
    const ok = await toggle(next);
    if (!ok) toast.error(errorMessage);
  };

  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Switch checked={enabled} onCheckedChange={handleToggle} disabled={saving} aria-label={ariaLabel} />
    </div>
  );
}
